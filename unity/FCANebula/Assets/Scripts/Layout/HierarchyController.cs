// FCA Memory Atlas — Unity Nebula Renderer
// HierarchyController: "click an Agent thinking node -> expand its sub-agent session nodes".
//
// Data contract (v0.3, shared with memory-pipeline/desktop):
//   child memory tags:  Agent子会话, subagent-session:<childId8>, parent-session:<parentId8>,
//                       workspace:<label>, parent-memory:<parentMemoryId>
//   parent tags:        one children:<childId8> tag per child (multiple tags), workspace:<label>
//   relations:          from=parent memory, to=child memory, relation_type=custom,
//                       label=spawned_subagent (fallback derived_from)  <-- highest priority
//
// Behaviour: child nodes start folded (hidden). Clicking a parent (or its ring) expands a
// circular fan of child nodes around the parent with animation and dashed gold filaments;
// clicking again or clicking the background collapses them. Child nodes can be selected and
// show their title/body excerpt in the existing inspector panel.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace FCANebula
{
    public sealed class HierarchyController : MonoBehaviour
    {
        NebulaApp _app;
        LayoutModel _layout;
        readonly HashSet<string> _expanded = new HashSet<string>(StringComparer.Ordinal);
        readonly List<HierarchyLink> _links = new List<HierarchyLink>();

        public int ParentCount { get; private set; }
        public int TotalChildCount { get; private set; }
        public int VisibleChildCount { get; private set; }
        public int ExpandedParentCount { get { return _expanded.Count; } }
        public bool HasHierarchy { get { return ParentCount > 0; } }

        public void Initialize(NebulaApp app)
        {
            _app = app;
        }

        public void OnLayoutApplied(LayoutModel layout)
        {
            _layout = layout;
            _links.Clear();
            ParentCount = 0;
            TotalChildCount = 0;
            VisibleChildCount = 0;
            if (layout == null)
            {
                PushToEdges();
                return;
            }

            // Fold everything first, then re-apply expansions (graph refreshes rebuild nodes).
            for (int i = 0; i < layout.Nodes.Count; i++)
            {
                LayoutNode node = layout.Nodes[i];
                if (node.IsHierarchyChild)
                {
                    node.IsVisible = false;
                    node.Position = node.BasePosition = ParentPosition(node);
                    TotalChildCount++;
                }
                else if (node.IsParent && node.ChildIds.Count > 0)
                {
                    ParentCount++;
                }
            }
            // Prune expanded parents that no longer exist / have no children.
            List<string> stale = new List<string>();
            foreach (string parentId in _expanded)
            {
                LayoutNode parent;
                if (!layout.ById.TryGetValue(parentId, out parent) || parent.ChildIds.Count == 0) stale.Add(parentId);
            }
            for (int i = 0; i < stale.Count; i++) _expanded.Remove(stale[i]);

            foreach (string parentId in _expanded)
            {
                ApplyExpanded(parentId);
            }
            RebuildLinks();
            Debug.Log("[FCA] Hierarchy: parents=" + ParentCount + " children=" + TotalChildCount +
                      " expandedParents=" + ExpandedParentCount + " visibleChildren=" + VisibleChildCount);
        }

        Vector3 ParentPosition(LayoutNode child)
        {
            if (_layout == null || string.IsNullOrEmpty(child.ParentId)) return child.Position;
            LayoutNode parent;
            return _layout.ById.TryGetValue(child.ParentId, out parent) ? parent.Position : child.Position;
        }

        public List<LayoutNode> GetChildren(LayoutNode parent)
        {
            List<LayoutNode> children = new List<LayoutNode>();
            if (parent == null || _layout == null) return children;
            for (int i = 0; i < parent.ChildIds.Count; i++)
            {
                LayoutNode child;
                if (_layout.ById.TryGetValue(parent.ChildIds[i], out child) && child.IsHierarchyChild)
                {
                    children.Add(child);
                }
            }
            return children;
        }

        public int ChildCount(string parentId)
        {
            LayoutNode parent;
            if (_layout == null || string.IsNullOrEmpty(parentId) || !_layout.ById.TryGetValue(parentId, out parent)) return 0;
            int count = 0;
            for (int i = 0; i < parent.ChildIds.Count; i++)
            {
                LayoutNode child;
                if (_layout.ById.TryGetValue(parent.ChildIds[i], out child) && child.IsHierarchyChild) count++;
            }
            return count;
        }

        public bool IsExpanded(string parentId)
        {
            return !string.IsNullOrEmpty(parentId) && _expanded.Contains(parentId);
        }

        /// <summary>Click behaviour: parent toggles its fan, any other node selects normally.</summary>
        public void HandleNodeClick(LayoutNode node)
        {
            if (node == null)
            {
                if (_app != null && _app.Nodes != null) _app.Nodes.ClearSelection();
                CollapseAll();
                return;
            }
            if (_app != null && _app.Nodes != null) _app.Nodes.Select(node, false);
            if (node.IsParent && node.ChildIds.Count > 0)
            {
                Toggle(node.Id);
            }
        }

        public void Toggle(string parentId)
        {
            if (_expanded.Contains(parentId)) Collapse(parentId);
            else Expand(parentId);
        }

        public void Expand(string parentId)
        {
            if (_layout == null || string.IsNullOrEmpty(parentId)) return;
            LayoutNode parent;
            if (!_layout.ById.TryGetValue(parentId, out parent) || parent.ChildIds.Count == 0) return;
            if (_expanded.Contains(parentId))
            {
                ApplyExpanded(parentId);
                return;
            }
            _expanded.Add(parentId);
            ApplyExpanded(parentId);
            RebuildLinks();
        }

        public void Collapse(string parentId)
        {
            if (string.IsNullOrEmpty(parentId)) return;
            bool removed = _expanded.Remove(parentId);
            LayoutNode parent;
            if (_layout != null && _layout.ById.TryGetValue(parentId, out parent))
            {
                List<LayoutNode> children = GetChildren(parent);
                for (int i = 0; i < children.Count; i++)
                {
                    children[i].IsVisible = false;
                    children[i].Position = parent.Position;
                    if (_app != null && _app.Nodes != null && ReferenceEquals(_app.Nodes.SelectedNode, children[i]))
                    {
                        _app.Nodes.ClearSelection();
                    }
                }
            }
            if (removed) RebuildLinks();
        }

        public void CollapseAll()
        {
            List<string> parents = new List<string>(_expanded);
            for (int i = 0; i < parents.Count; i++) Collapse(parents[i]);
            if (parents.Count > 0) RebuildLinks();
        }

        public void ExpandFirstParent()
        {
            if (_layout == null) return;
            for (int i = 0; i < _layout.Nodes.Count; i++)
            {
                LayoutNode node = _layout.Nodes[i];
                if (node.IsParent && node.ChildIds.Count > 0)
                {
                    if (_app != null && _app.Nodes != null) _app.Nodes.Select(node, false);
                    Expand(node.Id);
                    return;
                }
            }
        }

        void ApplyExpanded(string parentId)
        {
            LayoutNode parent;
            if (_layout == null || !_layout.ById.TryGetValue(parentId, out parent)) return;
            List<LayoutNode> children = GetChildren(parent);
            if (children.Count == 0) return;

            float baseAngle = Mathf.Atan2(parent.Position.y, parent.Position.x);
            float orbitRadius = Mathf.Max(24f, parent.Size * 1.9f + 14f);
            orbitRadius = Mathf.Min(orbitRadius, Mathf.Max(40f, _layout.MaxRadius * 0.18f));
            float phase = WorkspaceSpiralLayout.Hash01(parent.Id, 0x3C6EF372u) * Mathf.PI * 2f;
            for (int i = 0; i < children.Count; i++)
            {
                LayoutNode child = children[i];
                float t = children.Count <= 1 ? 0f : (float)i / children.Count;
                float angle = baseAngle + phase * 0.15f + (Mathf.PI * 2f * t);
                float jitter = (WorkspaceSpiralLayout.Hash01(child.Id, 0x94D049BBu) - 0.5f) * 0.18f;
                float radius = orbitRadius * (1f + jitter);
                float z = parent.Position.z + (WorkspaceSpiralLayout.Hash01(child.Id, 0xD192ED07u) - 0.5f) * 8f;
                child.Position = new Vector3(parent.Position.x + Mathf.Cos(angle) * radius,
                                             parent.Position.y + Mathf.Sin(angle) * radius,
                                             z);
                child.AlongArm = parent.AlongArm;
                child.IsVisible = true;
            }
            VisibleChildCount = CountVisibleChildren();
        }

        int CountVisibleChildren()
        {
            if (_layout == null) return 0;
            int n = 0;
            for (int i = 0; i < _layout.Nodes.Count; i++)
            {
                LayoutNode node = _layout.Nodes[i];
                if (node.IsHierarchyChild && node.IsVisible) n++;
            }
            return n;
        }

        void RebuildLinks()
        {
            _links.Clear();
            if (_layout != null)
            {
                foreach (string parentId in _expanded)
                {
                    LayoutNode parent;
                    if (!_layout.ById.TryGetValue(parentId, out parent)) continue;
                    List<LayoutNode> children = GetChildren(parent);
                    for (int i = 0; i < children.Count; i++)
                    {
                        HierarchyLink link = new HierarchyLink();
                        link.ParentId = parent.Id;
                        link.ChildId = children[i].Id;
                        _links.Add(link);
                    }
                }
            }
            VisibleChildCount = CountVisibleChildren();
            PushToEdges();
        }

        void PushToEdges()
        {
            if (_app != null && _app.Edges != null)
            {
                _app.Edges.SetHierarchyLinks(_links);
            }
        }
    }
}
