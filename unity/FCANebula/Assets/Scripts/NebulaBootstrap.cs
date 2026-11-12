// FCA Memory Atlas — Unity Nebula Renderer
// NebulaBootstrap: defensive runtime entry point so a build whose scene lost its rig still
// renders the nebula (the scene created by ProjectBootstrap.cs already contains NebulaApp).

using UnityEngine;

namespace FCANebula
{
    public static class NebulaBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void EnsureNebulaApp()
        {
            NebulaApp existing = null;
#if UNITY_2023_1_OR_NEWER
            existing = Object.FindFirstObjectByType<NebulaApp>();
#else
            existing = Object.FindObjectOfType<NebulaApp>();
#endif
            if (existing != null)
            {
                return;
            }
            GameObject root = new GameObject("FCA Nebula System");
            root.AddComponent<NebulaApp>();
            Debug.Log("[FCA] 场景缺少 NebulaApp，已由 NebulaBootstrap 自动创建渲染系统。");
        }
    }
}
