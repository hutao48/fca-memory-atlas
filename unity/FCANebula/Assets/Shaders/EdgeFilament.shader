// FCA Memory Atlas — Unity 6 / URP Nebula Renderer
// FCA/EdgeFilament: additive relation light-filaments. A single dynamic ribbon mesh is built
// on the CPU for all edges; this shader fades the ribbon across its width and animates a
// travelling light pulse (colour / dash / flow come from ThemePalette relation styles).
// Task-20: pass uses LightMode=UniversalForward so URP renders the additive ribbons.

Shader "FCA/EdgeFilament"
{
    Properties
    {
        _Intensity ("Intensity", Float) = 0.55
        _FlowSpeed ("Flow Speed", Float) = 0.55
    }

    SubShader
    {
        Tags { "Queue"="Transparent+10" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" }
        Blend One One
        ZWrite Off
        Cull Off

        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            float _Intensity;
            float _FlowSpeed;

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float2 uv2 : TEXCOORD1; // x = dash (0 solid), y = flow strength
                float4 color : COLOR;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float2 uv2 : TEXCOORD1;
                float4 color : COLOR;
            };

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.uv2 = v.uv2;
                o.color = v.color;
                return o;
            }

            float4 frag(v2f i) : SV_Target
            {
                float across = abs(i.uv.y * 2.0 - 1.0);
                float ribbon = pow(saturate(1.0 - across), 1.7);

                // Travelling pulse along the filament.
                float pulse = frac(i.uv.x * 1.4 - _Time.y * _FlowSpeed);
                float pulseGlow = pow(saturate(1.0 - abs(pulse - 0.5) * 2.0), 6.0) * i.uv2.y;

                // Optional dash pattern (knowledge_link / derived_from / custom).
                float dashMask = 1.0;
                if (i.uv2.x > 0.001)
                {
                    float segments = frac(i.uv.x * 7.0 - _Time.y * 0.35);
                    float gap = smoothstep(1.0 - i.uv2.x, 1.0 - i.uv2.x * 0.55, segments);
                    dashMask = lerp(1.0, gap, 0.9);
                }

                float3 col = i.color.rgb * i.color.a * ribbon * dashMask * (0.42 + 1.05 * pulseGlow) * _Intensity;
                return float4(col, 1.0);
            }
            ENDCG
        }
    }

    Fallback Off
}
