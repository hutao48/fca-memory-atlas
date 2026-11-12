// FCA Memory Atlas — Unity Nebula Renderer
// AppPaths: path resolution helpers that work in both the Editor and a standalone player.

using System;
using System.IO;
using UnityEngine;

namespace FCANebula
{
    public static class AppPaths
    {
        static string _repoRoot;

        /// <summary>Directory containing Assets/ in the Editor, or &lt;exe&gt;_Data in a player.</summary>
        public static string DataRoot
        {
            get { return Application.dataPath; }
        }

        /// <summary>unity/FCANebula in the Editor (folder that contains Assets/).</summary>
        public static string UnityProjectRoot
        {
            get
            {
                if (Application.isEditor)
                {
                    return Path.GetDirectoryName(Application.dataPath);
                }
                return Path.GetDirectoryName(Application.dataPath);
            }
        }

        /// <summary>Standalone executable directory (same as project root in the Editor).</summary>
        public static string ExecutableDirectory
        {
            get
            {
                if (Application.isEditor)
                {
                    return UnityProjectRoot;
                }
                return Path.GetDirectoryName(Application.dataPath);
            }
        }

        /// <summary>
        /// Repository root (D:\\FCA\\FCA-Memory-Atlas). Detected by walking up from the
        /// executable/project directory and looking for the repo marker folders.
        /// Falls back to the project root when the marker is not found.
        /// </summary>
        public static string RepoRoot
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                return "";
#else
                if (!string.IsNullOrEmpty(_repoRoot))
                {
                    return _repoRoot;
                }
                string start = UnityProjectRoot;
                string dir = start;
                for (int i = 0; i < 8 && !string.IsNullOrEmpty(dir); i++)
                {
                    if (Directory.Exists(Path.Combine(dir, "artifacts")) && Directory.Exists(Path.Combine(dir, "docs")))
                    {
                        _repoRoot = dir;
                        return _repoRoot;
                    }
                    DirectoryInfo parent = Directory.GetParent(dir);
                    dir = parent == null ? null : parent.FullName;
                }
                _repoRoot = start;
                return _repoRoot;
#endif
            }
        }

        /// <summary>
        /// Resolves a possibly relative path against the repository root and expands
        /// environment variables. Relative runtime data (screenshots) lands in the repo.
        /// </summary>
        public static string Resolve(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return "";
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            return path; // no filesystem in the WebGL player
#else
            string expanded = Expand(path);
            if (Path.IsPathRooted(expanded))
            {
                return Path.GetFullPath(expanded);
            }
            return Path.GetFullPath(Path.Combine(RepoRoot, expanded));
#endif
        }

        public static string EnsureDirectory(string path)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return path;
#else
            if (string.IsNullOrEmpty(path))
            {
                return "";
            }
            string dir = Path.HasExtension(path) ? Path.GetDirectoryName(path) : path;
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }
            return path;
#endif
        }

        public static string Expand(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return "";
            }
            return Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'));
        }

        public static string HomeDirectory()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return "";
#else
            string home = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrEmpty(home))
            {
                home = Environment.GetEnvironmentVariable("HOME");
            }
            if (string.IsNullOrEmpty(home))
            {
                home = ExecutableDirectory;
            }
            return home;
#endif
        }

        public static bool FileExists(string path)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return false;
#else
            try
            {
                return !string.IsNullOrEmpty(path) && File.Exists(path);
            }
            catch (Exception)
            {
                return false;
            }
#endif
        }
    }
}
