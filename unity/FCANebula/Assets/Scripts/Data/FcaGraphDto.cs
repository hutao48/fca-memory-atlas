// FCA Memory Atlas — Unity Nebula Renderer
// DTOs mirroring docs/PUBLIC_INTERFACE_FREEZE.md §3 / §5 (GET /api/v1/graph, /api/v1/state,
// /api/v1/memory/{id}). Parsed with Unity's built-in JsonUtility (no extra packages).

using System;
using System.Collections.Generic;
using UnityEngine;

namespace FCANebula
{
    // ---------------------------------------------------------------------
    // JSON DTOs (field names must match the frozen wire format exactly)
    // ---------------------------------------------------------------------

    [Serializable]
    public class Vec3Dto
    {
        public float x;
        public float y;
        public float z;

        public Vector3 ToVector3()
        {
            return new Vector3(x, y, z);
        }
    }

    [Serializable]
    public class FcaViewDto
    {
        public float[] center;
        public float zoom;
        public string view_id;
    }

    [Serializable]
    public class FcaNodeDto
    {
        public string id;
        public string kind;
        public string type;
        public string label;
        public float importance;
        public float display_weight;
        public float credibility;
        public string occurred_at;
        public int degree;
        public string cluster_id;
        public Vec3Dto position;
        public bool pinned;
        public string[] tags;
        public string[] tag_ids;
        public bool deleted;
        public bool agent_generated;
        public bool demo;
        // Only present on /api/v1/memory/{id} style payloads; ignored for graph nodes.
        public string title;
        public string body;
    }

    [Serializable]
    public class FcaEdgeDto
    {
        public string id;
        public string from;
        public string to;
        public string relation_type;
        public float weight;
        public bool directed;
        public float confidence;
        public string label;
        public bool deleted;
    }

    [Serializable]
    public class FcaClusterDto
    {
        public string id;
        public string label;
        public string[] node_ids;
        public Vec3Dto centroid;
        public float density;
        public string[] dominant_types;
        public string color_hint;
    }

    [Serializable]
    public class FcaStatsDto
    {
        public int nodes;
        public int edges;
        public int clusters;
        public string generated_at;
    }

    [Serializable]
    public class FcaGraphDto
    {
        public string api_version;
        public int layout_version;
        public FcaViewDto view;
        public FcaNodeDto[] nodes;
        public FcaEdgeDto[] edges;
        public FcaClusterDto[] clusters;
        public FcaStatsDto stats;
    }

    [Serializable]
    public class FcaCountsDto
    {
        public int memories;
        public int deleted_memories;
        public int demo_memories;
        public int entities;
        public int relations;
        public int tags;
        public int events;
        public int versions;
        public int layout_nodes;
        public int layout_views;
    }

    [Serializable]
    public class FcaIdentityDto
    {
        public string identity_id;
        public string display_name;
        public string summary;
        public int version;
        public string updated_at;
    }

    [Serializable]
    public class FcaCatalogTagDto
    {
        public string id;
        public string name;
        public int count;
        public string created_at;
    }

    [Serializable]
    public class FcaCatalogProjectDto
    {
        public string entity_id;
        public string name;
        public int count;
    }

    [Serializable]
    public class FcaCatalogsDto
    {
        public FcaCatalogTagDto[] tags;
        public FcaCatalogProjectDto[] projects;
    }

    [Serializable]
    public class FcaStateDto
    {
        public string api_version;
        public string product_version;
        public int version;
        public FcaCountsDto counts;
        public FcaIdentityDto identity;
        public FcaCatalogsDto catalogs;
        public float uptime_ms;
        public string updated_at;
    }

    [Serializable]
    public class FcaMemoryDto
    {
        public string id;
        public string title;
        public string body;
        public string memory_type;
        public string occurred_at;
        public string occurred_precision;
        public string occurred_end_at;
        public float credibility;
        public float importance;
        public float display_weight;
        public string[] tags;
        public string[] tag_names;
        public int version;
        public string origin;
        public string created_at;
        public string updated_at;
        public bool agent_generated;
    }

    [Serializable]
    public class FcaRelationDto
    {
        public string id;
        public string relation_type;
        public string label;
        public float confidence;
        public float weight;
        public bool directed;
    }

    [Serializable]
    public class FcaMemoryDetailDto
    {
        public FcaMemoryDto memory;
        public FcaRelationDto[] relations;
        public Vec3Dto layout;
        public int versions_count;
    }

    // ---------------------------------------------------------------------
    // Runtime model (validated, indexed, renderer friendly)
    // ---------------------------------------------------------------------

    public sealed class GraphNode
    {
        public string Id;
        public string Kind;
        public string Type;
        public string Label;
        public string ClusterId;
        public float Importance = 0.5f;
        public float DisplayWeight = 1f;
        public float Credibility = 0.5f;
        public int Degree;
        public string[] Tags;
        public bool Pinned;
        public bool AgentGenerated;
        public bool Demo;
        public string OccurredAt;
        public Vector3 ApiPosition;

        /// <summary>Workspace label resolved from tags (empty until the layout runs).</summary>
        public string WorkspaceLabel;
        public bool WorkspaceIsDefault;

        public bool IsEntity
        {
            get { return string.Equals(Kind, "entity", StringComparison.OrdinalIgnoreCase); }
        }

        public string DisplayTitle
        {
            get { return string.IsNullOrEmpty(Label) ? "（无标题）" : Label; }
        }

        public bool HasTag(string tag)
        {
            if (Tags == null || string.IsNullOrEmpty(tag))
            {
                return false;
            }
            for (int i = 0; i < Tags.Length; i++)
            {
                if (string.Equals(Tags[i], tag, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }
    }

    public sealed class GraphEdge
    {
        public string Id;
        public string From;
        public string To;
        public string RelationType;
        public string Label;
        public float Weight = 1f;
        public float Confidence = 0.5f;
        public bool Directed;
        public bool Deleted;
    }

    public sealed class GraphCluster
    {
        public string Id;
        public string Label;
        public string[] NodeIds;
        public Vector3 Centroid;
        public float Density;
        public string[] DominantTypes;
        public string ColorHint;
    }

    public sealed class GraphModel
    {
        public string ApiVersion = "1";
        public int LayoutVersion;
        public string GeneratedAt;
        public int ApiNodeCount;
        public int ApiEdgeCount;
        public readonly List<GraphNode> Nodes = new List<GraphNode>();
        public readonly List<GraphEdge> Edges = new List<GraphEdge>();
        public readonly List<GraphCluster> Clusters = new List<GraphCluster>();
        public readonly Dictionary<string, GraphNode> NodeIndex = new Dictionary<string, GraphNode>(StringComparer.Ordinal);

        public bool IsEmpty
        {
            get { return Nodes.Count == 0; }
        }

        public static GraphModel FromDto(FcaGraphDto dto)
        {
            GraphModel model = new GraphModel();
            if (dto == null)
            {
                return model;
            }
            model.ApiVersion = string.IsNullOrEmpty(dto.api_version) ? "1" : dto.api_version;
            model.LayoutVersion = dto.layout_version;
            model.GeneratedAt = dto.stats != null ? dto.stats.generated_at : null;
            model.ApiNodeCount = dto.stats != null ? dto.stats.nodes : (dto.nodes != null ? dto.nodes.Length : 0);
            model.ApiEdgeCount = dto.stats != null ? dto.stats.edges : (dto.edges != null ? dto.edges.Length : 0);

            int skippedDeleted = 0;
            if (dto.nodes != null)
            {
                for (int i = 0; i < dto.nodes.Length; i++)
                {
                    FcaNodeDto n = dto.nodes[i];
                    if (n == null || string.IsNullOrEmpty(n.id))
                    {
                        continue;
                    }
                    if (n.deleted)
                    {
                        skippedDeleted++;
                        continue;
                    }
                    GraphNode node = new GraphNode();
                    node.Id = n.id;
                    node.Kind = string.IsNullOrEmpty(n.kind) ? "memory" : n.kind;
                    node.Type = string.IsNullOrEmpty(n.type) ? "episodic" : n.type;
                    node.Label = string.IsNullOrEmpty(n.label) ? (string.IsNullOrEmpty(n.title) ? "" : n.title) : n.label;
                    node.ClusterId = n.cluster_id;
                    node.Importance = Mathf.Clamp01(n.importance);
                    node.DisplayWeight = Mathf.Clamp(n.display_weight, 0f, 2f);
                    node.Credibility = Mathf.Clamp01(n.credibility);
                    node.Degree = Mathf.Max(0, n.degree);
                    node.Tags = n.tags;
                    node.Pinned = n.pinned;
                    node.AgentGenerated = n.agent_generated;
                    node.Demo = n.demo;
                    node.OccurredAt = n.occurred_at;
                    node.ApiPosition = n.position != null ? n.position.ToVector3() : Vector3.zero;
                    model.Nodes.Add(node);
                    model.NodeIndex[node.Id] = node;
                }
            }
            if (skippedDeleted > 0)
            {
                Debug.Log("[FCA] Graph: skipped " + skippedDeleted + " soft-deleted node(s) from /api/v1/graph");
            }

            if (dto.edges != null)
            {
                for (int i = 0; i < dto.edges.Length; i++)
                {
                    FcaEdgeDto e = dto.edges[i];
                    if (e == null || string.IsNullOrEmpty(e.id) || e.deleted)
                    {
                        continue;
                    }
                    if (string.IsNullOrEmpty(e.from) || string.IsNullOrEmpty(e.to))
                    {
                        continue;
                    }
                    if (!model.NodeIndex.ContainsKey(e.from) || !model.NodeIndex.ContainsKey(e.to))
                    {
                        // Endpoint filtered out (deleted / not rendered) -> the renderer must not
                        // invent a node just to draw an edge.
                        continue;
                    }
                    GraphEdge edge = new GraphEdge();
                    edge.Id = e.id;
                    edge.From = e.from;
                    edge.To = e.to;
                    edge.RelationType = string.IsNullOrEmpty(e.relation_type) ? "custom" : e.relation_type;
                    edge.Label = e.label;
                    edge.Weight = Mathf.Max(0.05f, e.weight);
                    edge.Confidence = Mathf.Clamp01(e.confidence);
                    edge.Directed = e.directed;
                    edge.Deleted = e.deleted;
                    model.Edges.Add(edge);
                }
            }

            if (dto.clusters != null)
            {
                for (int i = 0; i < dto.clusters.Length; i++)
                {
                    FcaClusterDto c = dto.clusters[i];
                    if (c == null || string.IsNullOrEmpty(c.id))
                    {
                        continue;
                    }
                    GraphCluster cluster = new GraphCluster();
                    cluster.Id = c.id;
                    cluster.Label = c.label;
                    cluster.NodeIds = c.node_ids;
                    cluster.Centroid = c.centroid != null ? c.centroid.ToVector3() : Vector3.zero;
                    cluster.Density = c.density;
                    cluster.DominantTypes = c.dominant_types;
                    cluster.ColorHint = c.color_hint;
                    model.Clusters.Add(cluster);
                }
            }
            return model;
        }
    }

    /// <summary>Memory detail fetched on demand for the click-through inspector panel.</summary>
    public sealed class MemoryInfo
    {
        public string Id;
        public string Title;
        public string Body;
        public string MemoryType;
        public string OccurredAt;
        public float Credibility;
        public float Importance;
        public float DisplayWeight;
        public string[] Tags;
        public int Version;
        public bool AgentGenerated;
        public int RelationCount;

        public static MemoryInfo FromDetailDto(FcaMemoryDetailDto dto)
        {
            if (dto == null || dto.memory == null || string.IsNullOrEmpty(dto.memory.id))
            {
                return null;
            }
            FcaMemoryDto m = dto.memory;
            MemoryInfo info = new MemoryInfo();
            info.Id = m.id;
            info.Title = string.IsNullOrEmpty(m.title) ? m.id : m.title;
            info.Body = m.body;
            info.MemoryType = m.memory_type;
            info.OccurredAt = m.occurred_at;
            info.Credibility = m.credibility;
            info.Importance = m.importance;
            info.DisplayWeight = m.display_weight;
            info.Tags = (m.tag_names != null && m.tag_names.Length > 0) ? m.tag_names : m.tags;
            info.Version = m.version;
            info.AgentGenerated = m.agent_generated;
            info.RelationCount = dto.relations != null ? dto.relations.Length : 0;
            return info;
        }

        public string BodyExcerpt(int maxChars)
        {
            if (string.IsNullOrEmpty(Body))
            {
                return "";
            }
            string body = Body.Replace("\r\n", "\n").Replace('\r', '\n');
            if (body.Length <= maxChars)
            {
                return body;
            }
            return body.Substring(0, maxChars).TrimEnd() + " …";
        }
    }
}
