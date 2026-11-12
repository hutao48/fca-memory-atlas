// FCA Memory Atlas — Unity Nebula Renderer (Built-in Render Pipeline)
// FCA/NebulaPost: bloom prefilter + separable blur + final composite
// (ACES tonemap, exposure, vignette, film grain, dithering). Applied in OnRenderImage.

Shader "FCA/NebulaPost"
{
    Properties
    {
        _MainTex ("Source", 2D) = "white" {}
        _BloomTex ("Bloom", 2D) = "black" {}
        _Threshold ("Bloom Threshold", Float) = 0.72
        _Knee ("Bloom Knee", Float) = 0.35
        _BloomIntensity ("Bloom Intensity", Float) = 0.9
        _Exposure ("Exposure", Float) = 1.05
        _Vignette ("Vignette", Float) = 0.85
        _Grain ("Grain", Float) = 0.012
    }

    SubShader
    {
        Cull Off
        ZWrite Off
        ZTest Always

        // Pass 0: bloom prefilter + 4-tap downsample.
        Pass
        {
            CGPROGRAM
            #pragma vertex vert_img
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_TexelSize;
            float _Threshold;
            float _Knee;

            float4 frag(v2f_img i) : SV_Target
            {
                float2 texel = _MainTex_TexelSize.xy;
                float3 c = tex2D(_MainTex, i.uv).rgb;
                c += tex2D(_MainTex, i.uv + float2(texel.x, texel.y)).rgb;
                c += tex2D(_MainTex, i.uv + float2(-texel.x, texel.y)).rgb;
                c += tex2D(_MainTex, i.uv + float2(texel.x, -texel.y)).rgb;
                c += tex2D(_MainTex, i.uv + float2(-texel.x, -texel.y)).rgb;
                c *= 0.2;

                float br = max(c.r, max(c.g, c.b));
                float knee = max(_Knee, 1e-4);
                float soft = clamp(br - _Threshold + knee, 0.0, 2.0 * knee);
                soft = soft * soft / (4.0 * knee + 1e-4);
                float contribution = max(soft, br - _Threshold) / max(br, 1e-4);
                return float4(c * contribution, 1.0);
            }
            ENDCG
        }

        // Pass 1: horizontal gaussian blur.
        Pass
        {
            CGPROGRAM
            #pragma vertex vert_img
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_TexelSize;

            float4 frag(v2f_img i) : SV_Target
            {
                float2 texel = _MainTex_TexelSize.xy;
                float3 c = tex2D(_MainTex, i.uv).rgb * 0.227027;
                c += tex2D(_MainTex, i.uv + float2(texel.x * 1.3846, 0.0)).rgb * 0.316216;
                c += tex2D(_MainTex, i.uv + float2(-texel.x * 1.3846, 0.0)).rgb * 0.316216;
                c += tex2D(_MainTex, i.uv + float2(texel.x * 3.2308, 0.0)).rgb * 0.070270;
                c += tex2D(_MainTex, i.uv + float2(-texel.x * 3.2308, 0.0)).rgb * 0.070270;
                return float4(c, 1.0);
            }
            ENDCG
        }

        // Pass 2: vertical gaussian blur.
        Pass
        {
            CGPROGRAM
            #pragma vertex vert_img
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_TexelSize;

            float4 frag(v2f_img i) : SV_Target
            {
                float2 texel = _MainTex_TexelSize.xy;
                float3 c = tex2D(_MainTex, i.uv).rgb * 0.227027;
                c += tex2D(_MainTex, i.uv + float2(0.0, texel.y * 1.3846)).rgb * 0.316216;
                c += tex2D(_MainTex, i.uv + float2(0.0, -texel.y * 1.3846)).rgb * 0.316216;
                c += tex2D(_MainTex, i.uv + float2(0.0, texel.y * 3.2308)).rgb * 0.070270;
                c += tex2D(_MainTex, i.uv + float2(0.0, -texel.y * 3.2308)).rgb * 0.070270;
                return float4(c, 1.0);
            }
            ENDCG
        }

        // Pass 3: final composite.
        Pass
        {
            CGPROGRAM
            #pragma vertex vert_img
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            sampler2D _BloomTex;
            float _BloomIntensity;
            float _Exposure;
            float _Vignette;
            float _Grain;

            float3 ACESFilm(float3 x)
            {
                float a = 2.51;
                float b = 0.03;
                float c = 2.43;
                float d = 0.59;
                float e = 0.14;
                return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
            }

            float4 frag(v2f_img i) : SV_Target
            {
                float3 scene = tex2D(_MainTex, i.uv).rgb;
                float3 bloom = tex2D(_BloomTex, i.uv).rgb;
                float3 col = (scene + bloom * _BloomIntensity) * _Exposure;
                col = ACESFilm(col);

                float2 centered = i.uv - 0.5;
                float vignette = saturate(1.0 - dot(centered, centered) * _Vignette * 1.9);
                col *= lerp(0.58, 1.0, vignette);

                float grain = frac(sin(dot(i.uv * _ScreenParams.xy + _Time.y * 37.0, float2(12.9898, 78.233))) * 43758.5453);
                col += (grain - 0.5) * _Grain;

                col += (frac(sin(dot(i.uv * 1024.0, float2(41.7, 289.1))) * 43758.5453) - 0.5) * (1.0 / 255.0);
                return float4(max(col, 0.0), 1.0);
            }
            ENDCG
        }
    }

    Fallback Off
}
