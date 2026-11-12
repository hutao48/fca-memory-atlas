// FCA Memory Atlas — Unity Nebula Renderer
// ThemePalette: single source of truth for nebula colours, workspace arm palette,
// node-type colours and relation filament styles (mirrors desktop/renderer/nebula/palette.js).

using System.Collections.Generic;
using UnityEngine;

namespace FCANebula
{
    public struct RelationStyle
    {
        public Color Color;      // sRGB
        public string Label;
        public float Flow;       // 0..1 animated pulse strength
        public float Width;      // relative ribbon width
        public float Curve;      // perpendicular bezier offset factor
        public float Dash;       // 0 = solid, >0 = dashed flow
    }

    public struct ArmPaletteEntry
    {
        public string Key;
        public string Label;
        public Color Color;      // sRGB
    }

    public static class ThemePalette
    {
        /// <summary>Hard limit of workspace arms that can be expressed by the volume shader.</summary>
        public const int MaxShaderArms = 8;

        public static readonly Color SpaceColor = HexToColor("#04060D");
        public static readonly Color SkyTint = HexToColor("#0B1226");
        public static readonly Color CoreColor = HexToColor("#F2D6A2");
        public static readonly Color BulgeColor = HexToColor("#E8B36B");
        public static readonly Color DustColor = HexToColor("#0D0A12");
        public static readonly Color UiText = HexToColor("#D9E4F5");
        public static readonly Color UiDim = HexToColor("#8FA0BD");
        public static readonly Color UiAccent = HexToColor("#7FD3EA");
        public static readonly Color UiOk = HexToColor("#7CE0B4");
        public static readonly Color UiWarn = HexToColor("#F0C27B");
        public static readonly Color UiError = HexToColor("#F07C86");

        // Required workspace arm hues, in stable order (cyan, blue, violet, magenta, rose, gold).
        static readonly ArmPaletteEntry[] NamedArms = new ArmPaletteEntry[]
        {
            MakeArm("cyan", "青蓝", "#57C9E8"),
            MakeArm("blue", "深蓝", "#4D7FE6"),
            MakeArm("violet", "紫罗兰", "#8A6FE6"),
            MakeArm("magenta", "洋红", "#C25EAE"),
            MakeArm("rose", "玫瑰", "#DF8899"),
            MakeArm("gold", "暗金", "#E5B46B")
        };

        static readonly ArmPaletteEntry DefaultArm = MakeArm("default", "冷白偏蓝", "#9DB4D8");

        static readonly Dictionary<string, Color> MemoryTypeColors = new Dictionary<string, Color>
        {
            { "working", HexToColor("#D6E4FF") },
            { "episodic", HexToColor("#8FB8EE") },
            { "semantic", HexToColor("#77D3E2") },
            { "procedural", HexToColor("#7ED0C0") },
            { "autobiographical", HexToColor("#AD9DEA") },
            { "project", HexToColor("#E8C98A") },
            { "relational", HexToColor("#DD93BF") },
            { "emotional", HexToColor("#E8A2AB") }
        };

        static readonly Dictionary<string, Color> EntityTypeColors = new Dictionary<string, Color>
        {
            { "person", HexToColor("#E4DDC9") },
            { "project", HexToColor("#D8BF8A") },
            { "place", HexToColor("#93C6D6") },
            { "concept", HexToColor("#B3AADA") },
            { "organization", HexToColor("#C9B7A0") },
            { "other", HexToColor("#B9C4D6") }
        };

        static readonly Dictionary<string, RelationStyle> RelationStyles;

        static ThemePalette()
        {
            RelationStyles = new Dictionary<string, RelationStyle>();
            AddRelation("temporal_before", "此前", "#8FA6D2", 0f, 0.18f, 0.9f, 0.10f);
            AddRelation("temporal_after", "此后", "#8FA6D2", 0f, 0.18f, 0.9f, 0.10f);
            AddRelation("participates_in", "参与", "#7ECBE0", 0f, 0.30f, 1.0f, 0.16f);
            AddRelation("shared_experience", "共同经历", "#AE9BE8", 0f, 0.30f, 1.0f, 0.20f);
            AddRelation("knowledge_link", "知识关联", "#8BB0DE", 0.5f, 0.14f, 0.8f, 0.12f);
            AddRelation("causal", "因果", "#DFB982", 0f, 0.26f, 1.05f, 0.18f);
            AddRelation("derived_from", "派生自", "#86D6C6", 0.35f, 0.20f, 0.85f, 0.14f);
            AddRelation("belongs_to_project", "属于项目", "#D4BD8C", 0f, 0.22f, 0.95f, 0.14f);
            AddRelation("emotional_link", "情感连接", "#E39AB6", 0f, 0.34f, 1.0f, 0.22f);
            AddRelation("custom", "自定义", "#C0CAD8", 0.2f, 0.15f, 0.9f, 0.12f);
        }

        static void AddRelation(string key, string label, string hex, float dash, float flow, float width, float curve)
        {
            RelationStyle style = new RelationStyle();
            style.Color = HexToColor(hex);
            style.Label = label;
            style.Dash = dash;
            style.Flow = flow;
            style.Width = width;
            style.Curve = curve;
            RelationStyles[key] = style;
        }

        static ArmPaletteEntry MakeArm(string key, string label, string hex)
        {
            ArmPaletteEntry e = new ArmPaletteEntry();
            e.Key = key;
            e.Label = label;
            e.Color = HexToColor(hex);
            return e;
        }

        /// <summary>Stable list of the six required named arm hues (for docs / legend).</summary>
        public static ArmPaletteEntry[] GetNamedArmEntries()
        {
            ArmPaletteEntry[] copy = new ArmPaletteEntry[NamedArms.Length];
            for (int i = 0; i < NamedArms.Length; i++)
            {
                copy[i] = NamedArms[i];
            }
            return copy;
        }

        public static ArmPaletteEntry GetDefaultArmEntry()
        {
            return DefaultArm;
        }

        /// <summary>
        /// Colour for one workspace spiral arm. Named workspaces use cyan/blue/violet/
        /// magenta/rose/gold in stable order; extra workspaces cycle with a small hue shift;
        /// the catch-all "default" arm is always cold white so it reads as "unclassified".
        /// </summary>
        public static Color ArmColor(bool isDefault, int namedOrdinal)
        {
            if (isDefault)
            {
                return DefaultArm.Color;
            }
            int index = namedOrdinal < 0 ? 0 : namedOrdinal;
            Color baseColor = NamedArms[index % NamedArms.Length].Color;
            int cycle = index / NamedArms.Length;
            if (cycle <= 0)
            {
                return baseColor;
            }
            float h, s, v;
            Color.RGBToHSV(baseColor, out h, out s, out v);
            h = Mathf.Repeat(h + 0.083f * cycle, 1f);
            s = Mathf.Clamp01(s * 0.94f);
            return Color.HSVToRGB(h, s, v);
        }

        public static string ArmColorKey(bool isDefault, int namedOrdinal)
        {
            if (isDefault)
            {
                return DefaultArm.Key;
            }
            int index = namedOrdinal < 0 ? 0 : namedOrdinal;
            return NamedArms[index % NamedArms.Length].Key;
        }

        /// <summary>Base emission colour for a memory/entity node, mixing its type hue with its arm hue.</summary>
        public static Color NodeTint(Color armSrgb, bool isEntity, string type)
        {
            Color typeColor = TypeColor(isEntity, type);
            Color mixed = Color.Lerp(typeColor, armSrgb, 0.35f);
            // Nodes lean white so they read as stars on top of same-hue nebula.
            return Color.Lerp(mixed, Color.white, 0.22f);
        }

        public static Color TypeColor(bool isEntity, string type)
        {
            Dictionary<string, Color> table = isEntity ? EntityTypeColors : MemoryTypeColors;
            Color c;
            if (!string.IsNullOrEmpty(type) && table.TryGetValue(type, out c))
            {
                return c;
            }
            return isEntity ? EntityTypeColors["other"] : MemoryTypeColors["episodic"];
        }

        public static RelationStyle Relation(string relationType)
        {
            RelationStyle style;
            if (!string.IsNullOrEmpty(relationType) && RelationStyles.TryGetValue(relationType, out style))
            {
                return style;
            }
            return RelationStyles["custom"];
        }

        public static string RelationLabel(string relationType)
        {
            return Relation(relationType).Label;
        }

        /// <summary>Converts an sRGB authored colour to the colour space the renderer expects.</summary>
        public static Color ToShader(Color srgb)
        {
            if (QualitySettings.activeColorSpace == ColorSpace.Linear)
            {
                return SrgbToLinear(srgb);
            }
            return srgb;
        }

        public static Color ShaderColor(string hex)
        {
            return ToShader(HexToColor(hex));
        }

        public static Color SrgbToLinear(Color c)
        {
            return new Color(ChannelToLinear(c.r), ChannelToLinear(c.g), ChannelToLinear(c.b), c.a);
        }

        static float ChannelToLinear(float value)
        {
            if (value <= 0.04045f)
            {
                return value / 12.92f;
            }
            return Mathf.Pow((value + 0.055f) / 1.055f, 2.4f);
        }

        public static Color HexToColor(string hex)
        {
            if (string.IsNullOrEmpty(hex))
            {
                return Color.magenta;
            }
            string h = hex.Trim();
            if (h.StartsWith("#", System.StringComparison.Ordinal))
            {
                h = h.Substring(1);
            }
            if (h.Length == 6)
            {
                int n;
                if (int.TryParse(h, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out n))
                {
                    float r = ((n >> 16) & 255) / 255f;
                    float g = ((n >> 8) & 255) / 255f;
                    float b = (n & 255) / 255f;
                    return new Color(r, g, b, 1f);
                }
            }
            if (h.Length == 8)
            {
                uint n;
                if (uint.TryParse(h, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out n))
                {
                    float r = ((n >> 24) & 255) / 255f;
                    float g = ((n >> 16) & 255) / 255f;
                    float b = ((n >> 8) & 255) / 255f;
                    float a = (n & 255) / 255f;
                    return new Color(r, g, b, a);
                }
            }
            return Color.magenta;
        }

        public static Color WithAlpha(Color c, float a)
        {
            return new Color(c.r, c.g, c.b, a);
        }

        public static Color Multiply(Color c, float factor)
        {
            return new Color(c.r * factor, c.g * factor, c.b * factor, c.a);
        }
    }
}
