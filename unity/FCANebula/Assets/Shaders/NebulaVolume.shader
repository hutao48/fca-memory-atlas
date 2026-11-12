// FCA Memory Atlas — Unity Nebula Renderer (Built-in Render Pipeline)
// FCA/NebulaVolume: procedural volumetric nebula rendered on a camera-attached fullscreen
// quad (Background queue). Logarithmic spiral arms follow WorkspaceSpiralLayout exactly.
// Each workspace arm has its own emission colour; FBM + domain warp gives gas/dust structure.

Shader "FCA/NebulaVolume"
{
    Properties
    {
        _VolumeRadius ("Volume Radius", Float) = 640
        _EmissionScale ("Emission Scale", Float) = 1.0
        _Absorption ("Dust Absorption", Float) = 1.25
        _NoiseScale ("Primary Noise Scale", Float) = 0.005
        _NoiseScale2 ("Dust Noise Scale", Float) = 0.014
        _NoiseWarp ("Domain Warp", Float) = 13.0
        _DustStrength ("Dust Strength", Float) = 1.15
        _CoreRadius ("Core Radius", Float) = 92
        _CoreGlow ("Core Glow", Float) = 1.0
        _HaloStrength ("Outer Halo", Float) = 1.0
        _StarDensity ("Star Density", Float) = 1.0
        _BandIntensity ("Galaxy Band Intensity", Float) = 0.55
        _Steps ("March Steps", Int) = 48
        _Octaves ("Noise Octaves", Int) = 3
        _VolumeEnabled ("Volume Enabled", Float) = 1
    }

    SubShader
    {
        Tags { "Queue"="Background" "RenderType"="Opaque" "PreviewType"="Plane" }
        Cull Off
        ZWrite Off
        ZTest Always

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
#if defined(SHADER_API_WEBGL) || defined(SHADER_API_GLES) || defined(SHADER_API_GLES3)
            // WebGL2 = OpenGL ES 3.0 feature level: the uniform-array raymarch loop compiles,
            // but shader model 4.5 entry points are not available.
            #pragma target 3.0
#else
            #pragma target 4.5
#endif
            #include "UnityCG.cginc"

            #define MAX_ARMS 8
            #define MAX_STEPS 96
            #define PI 3.14159265359

            float4 _ArmColors[MAX_ARMS];   // rgb = linear emission colour, a = intensity
            float4 _ArmParams[MAX_ARMS];   // x = base angle, y = inner radius, z = pitch b, w = span
            float4 _ArmShape[MAX_ARMS];    // x = radial width, y = vertical sigma, z = intensity, w = phase
            float _ArmCount;
            float _SpiralHand;
            float3 _CoreColor;
            float3 _SpaceColor;
            float3 _SkyTint;

            float _VolumeRadius;
            float _EmissionScale;
            float _Absorption;
            float _NoiseScale;
            float _NoiseScale2;
            float _NoiseWarp;
            float _DustStrength;
            float _CoreRadius;
            float _CoreGlow;
            float _HaloStrength;
            float _StarDensity;
            float _BandIntensity;
            float _VolumeEnabled;
            int _Steps;
            int _Octaves;

            struct appdata
            {
                float4 vertex : POSITION;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float3 worldDir : TEXCOORD0;
            };

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                float3 worldPos = mul(unity_ObjectToWorld, v.vertex).xyz;
                o.worldDir = worldPos - _WorldSpaceCameraPos;
                return o;
            }

            float hash13(float3 p)
            {
                p = frac(p * 0.1031);
                p += dot(p, p.yzx + 33.33);
                return frac((p.x + p.y) * p.z);
            }

            float vnoise(float3 x)
            {
                float3 i = floor(x);
                float3 f = frac(x);
                f = f * f * (3.0 - 2.0 * f);
                float n000 = hash13(i + float3(0.0, 0.0, 0.0));
                float n100 = hash13(i + float3(1.0, 0.0, 0.0));
                float n010 = hash13(i + float3(0.0, 1.0, 0.0));
                float n110 = hash13(i + float3(1.0, 1.0, 0.0));
                float n001 = hash13(i + float3(0.0, 0.0, 1.0));
                float n101 = hash13(i + float3(1.0, 0.0, 1.0));
                float n011 = hash13(i + float3(0.0, 1.0, 1.0));
                float n111 = hash13(i + float3(1.0, 1.0, 1.0));
                float nx00 = lerp(n000, n100, f.x);
                float nx10 = lerp(n010, n110, f.x);
                float nx01 = lerp(n001, n101, f.x);
                float nx11 = lerp(n011, n111, f.x);
                float nxy0 = lerp(nx00, nx10, f.y);
                float nxy1 = lerp(nx01, nx11, f.y);
                return lerp(nxy0, nxy1, f.z);
            }

            float fbm(float3 p, int octaves)
            {
                float sum = 0.0;
                float amp = 0.5;
                float norm = 0.0;
                for (int i = 0; i < 4; i++)
                {
                    if (i >= octaves)
                    {
                        break;
                    }
                    sum += amp * vnoise(p);
                    norm += amp;
                    p = p * 2.03 + 17.3;
                    amp *= 0.5;
                }
                return sum / max(norm, 1e-4);
            }

            float2 SphereIntersect(float3 ro, float3 rd, float3 center, float radius)
            {
                float3 oc = ro - center;
                float b = dot(oc, rd);
                float c = dot(oc, oc) - radius * radius;
                float h = b * b - c;
                if (h < 0.0)
                {
                    return float2(1.0, -1.0);
                }
                h = sqrt(h);
                return float2(-b - h, -b + h);
            }

            // Returns rgb = accumulated emission, a = dust extinction density.
            float4 EvaluateNebula(float3 p)
            {
                float2 xy = p.xy;
                float r = length(xy);
                float theta = atan2(p.y, p.x);

                // Gas structure: fbm with domain warp (never a flat "cotton ball").
                float3 q = p * _NoiseScale;
                float3 warp;
                warp.x = vnoise(q * 0.55 + 11.1);
                warp.y = vnoise(q * 0.55 + 31.7);
                warp.z = vnoise(q * 0.55 + 51.3);
                q += (warp - 0.5) * 0.55;
                float cloud = fbm(q, _Octaves);
                float fine = fbm(p * _NoiseScale2 + 53.0, 2);
                float gas = saturate(cloud * 1.62 - 0.26);
                // Mid/high frequency structure breaks the arms into gas filaments and knots.
                float structure = smoothstep(0.22, 0.80, fine);

                float3 acc = float3(0.0, 0.0, 0.0);
                float density = 0.0;
                int armCount = (int)_ArmCount;

                for (int i = 0; i < MAX_ARMS; i++)
                {
                    if (i >= armCount)
                    {
                        break;
                    }
                    float4 prm = _ArmParams[i];
                    float4 shp = _ArmShape[i];
                    float baseAngle = prm.x;
                    float innerR = prm.y;
                    float pitch = prm.z;
                    float span = prm.w;

                    // Unwrap the sweep angle instead of naive fmod: with N arms and
                    // baseAngle+span > 2π (always true for multi-arm layouts) a simple wrap
                    // would fold the outer part of an arm into a wrong angular sector and the
                    // volume cloud would drift away from the node layout (task-14 bug).
                    float rel = _SpiralHand > 0.0 ? (theta - baseAngle) : (baseAngle - theta);
                    rel -= 2.0 * PI * round((rel - span * 0.5) / (2.0 * PI));
                    if (rel < 0.0 || rel > span)
                    {
                        continue;
                    }

                    float expected = innerR * exp(pitch * rel);
                    float dr = r - expected;
                    float tNorm = saturate(rel / max(span, 1e-3));
                    float widthNow = shp.x * (0.65 + 0.55 * tNorm);
                    float radial = exp(-(dr * dr) / max(widthNow * widthNow, 1e-4));
                    float vert = exp(-(p.z * p.z) / max(shp.y * shp.y, 1e-4));
                    float edge = smoothstep(0.0, 0.30, rel) * smoothstep(0.0, 0.55, span - rel);
                    float armDensity = radial * vert * edge * shp.z * (0.055 + 0.42 * gas) * (0.42 + 0.95 * structure);
                    density += armDensity;
                    acc += _ArmColors[i].rgb * _ArmColors[i].a * armDensity;
                }

                // Central bulge (warm, compact).
                float rc = length(p);
                float coreR = max(_CoreRadius, 1.0);
                float coreVert = exp(-(p.z * p.z) / max(coreR * coreR * 0.55, 1.0));
                float bulge = exp(-rc / coreR) * coreVert;
                float coreDensity = bulge * _CoreGlow;
                density += coreDensity * 0.10;
                acc += _CoreColor * coreDensity * 0.22;

                // Very faint outer halo so the disc never ends on a hard edge.
                acc += _SkyTint * (0.004 * _HaloStrength) * exp(-rc / max(_VolumeRadius * 0.55, 1.0));

                // Dust lanes: high frequency blotches, attenuated by arm gas; the gas itself
                // also absorbs (self-occlusion) so the nebula gets depth instead of a flat blob.
                float dust = _DustStrength * smoothstep(0.48, 0.94, fine) * saturate(density * 3.0);
                float extinction = dust + density * 0.55;
                return float4(acc, extinction);
            }

            float3 StarField(float3 dir, float scale, float threshold, float seed)
            {
                float3 p = dir * scale;
                float3 cell = floor(p);
                float3 f = frac(p) - 0.5;
                float h = hash13(cell + seed);
                float3 col = float3(0.0, 0.0, 0.0);
                if (h > threshold)
                {
                    float3 off;
                    off.x = hash13(cell + 3.1);
                    off.y = hash13(cell + 5.7);
                    off.z = hash13(cell + 9.3);
                    off -= 0.5;
                    float d = length(f - off * 0.62);
                    float b = pow(saturate(1.0 - d * 2.6), 6.0);
                    float tint = hash13(cell + 13.9);
                    float3 starCol = lerp(float3(0.65, 0.78, 1.0), float3(1.0, 0.86, 0.68), tint);
                    col = starCol * b * (0.45 + 0.85 * hash13(cell + 21.7));
                }
                return col;
            }

            float3 DeepSpace(float3 dir)
            {
                float absZ = saturate(abs(dir.z));
                float3 col = _SpaceColor * (0.85 + 0.30 * (1.0 - absZ));
                // Galaxy band: faint emission in the disc plane.
                float band = exp(-absZ * absZ * 9.0) * _BandIntensity;
                float bandNoise = fbm(dir * 4.2 + 5.0, 3);
                col += _SkyTint * band * (0.18 + 0.62 * bandNoise);
                // Two parallax layers of procedural stars.
                col += StarField(dir, 130.0, 0.985, 1.7) * 0.9;
                col += StarField(dir, 260.0, 0.992, 7.3) * 0.7;
                col *= _StarDensity;
                return col;
            }

            float4 frag(v2f i) : SV_Target
            {
                float3 rd = normalize(i.worldDir);
                float3 background = DeepSpace(rd);
                float3 scattered = float3(0.0, 0.0, 0.0);
                float transmittance = 1.0;

                if (_VolumeEnabled > 0.5 && _Steps > 0)
                {
                    float2 hit = SphereIntersect(_WorldSpaceCameraPos, rd, float3(0.0, 0.0, 0.0), _VolumeRadius);
                    float tNear = max(hit.x, 0.0);
                    float tFar = hit.y;
                    if (tFar > tNear)
                    {
                        int steps = _Steps;
                        float dt = (tFar - tNear) / (float)steps;
                        float jitter = hash13(float3(i.pos.xy, _Time.y));
                        float t = tNear + dt * jitter;
                        float emissionScale = _EmissionScale * dt;
                        for (int s = 0; s < MAX_STEPS; s++)
                        {
                            if (s >= steps)
                            {
                                break;
                            }
                            float3 p = _WorldSpaceCameraPos + rd * t;
                            float4 sample4 = EvaluateNebula(p);
                            scattered += transmittance * sample4.rgb * emissionScale;
                            transmittance *= exp(-sample4.a * _Absorption * dt);
                            t += dt;
                            if (transmittance < 0.012)
                            {
                                break;
                            }
                        }
                    }
                }

                float3 col = background * transmittance + scattered;
                // 8-bit dithering against banding in the deep background.
                float dither = (hash13(float3(i.pos.xy, _Time.x * 13.0)) - 0.5) * (1.0 / 255.0);
                return float4(max(col + dither, 0.0), 1.0);
            }
            ENDCG
        }
    }

    Fallback Off
}
