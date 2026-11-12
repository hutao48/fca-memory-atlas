// FCA Memory Atlas — Unity Nebula Renderer (Built-in Render Pipeline)
// FCA/NodeStar: additive star billboard sprite. NodeRenderer batches all nodes into one
// dynamic mesh (4 vertices per node, one draw call) and bakes per-node colour / brightness /
// selection state into the vertex streams — this avoids MaterialPropertyBlock instancing
// pitfalls and renders reliably in standalone Windows builds.

Shader "FCA/NodeStar"
{
    Properties
    {
        _HaloPower ("Halo Power", Float) = 3.4
        _CorePower ("Core Power", Float) = 9.0
        _Intensity ("Intensity", Float) = 1.0
    }

    SubShader
    {
        Tags { "Queue"="Transparent+20" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" }
        Blend One One
        ZWrite Off
        Cull Off

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            float _HaloPower;
            float _CorePower;
            float _Intensity;

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float2 extra : TEXCOORD1; // x selection, y hover, z twinkle phase
                float4 color : COLOR;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float2 extra : TEXCOORD1;
                float4 color : COLOR;
            };

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.extra = v.extra;
                o.color = v.color;
                return o;
            }

            float4 frag(v2f i) : SV_Target
            {
                float2 p = i.uv * 2.0 - 1.0;
                float r = length(p);
                float core = pow(saturate(1.0 - r), _CorePower);
                float halo = exp(-r * r * _HaloPower);
                float twinkle = 0.92 + 0.08 * sin(_Time.y * 1.7 + i.color.a * 6.2831);

                float3 col = i.color.rgb * (halo * 2.3 + core * 3.6) * twinkle;
                // Every node keeps a white-hot core so it stays readable on top of an arm whose
                // nebula colour is close to its own tint (e.g. memories on the cyan FCA arm).
                col += float3(1.0, 0.97, 0.93) * (core * core * 1.4 + pow(saturate(0.55 - r), 4.0) * 1.2);

                // Selection ring + soft hover ring + expandable-parent ring.
                float selRing = smoothstep(0.055, 0.0, abs(r - 0.74)) * i.extra.x;
                col += float3(0.80, 0.92, 1.10) * selRing * 1.1;
                float parentFlag = step(1.5, i.extra.y);
                float hoverFlag = step(0.5, i.extra.y) * step(i.extra.y, 1.5);
                float hoverRing = smoothstep(0.05, 0.0, abs(r - 0.92)) * hoverFlag;
                col += float3(0.55, 0.68, 0.90) * hoverRing * 0.40;
                // Expandable parent memories get a pulsing gold ring (task-14 hierarchy affordance).
                float parentPulse = 0.65 + 0.35 * sin(_Time.y * 2.2 + i.color.a * 6.2831);
                float parentRing = smoothstep(0.05, 0.0, abs(r - 0.82)) * parentFlag;
                col += float3(0.95, 0.84, 0.58) * parentRing * 0.65 * parentPulse;

                return float4(col * _Intensity, 1.0);
            }
            ENDCG
        }
    }

    Fallback Off
}
