#version 300 es
// Итоговое изображение: ореол + экспозиция + тональная компрессия ACES + sRGB.
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uHdr, uBloom;
uniform float uExposure;   // множитель 2^EV
uniform float uBloomStr;
uniform float uBloomNorm; // 1 / число уровней пирамиды
uniform int uRaw;          // научные карты — без ореола и компрессии

vec3 aces(vec3 x) { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec3 hdr = texture(uHdr, vUv).rgb;
  vec3 c;
  if (uRaw == 1) c = clamp(hdr, 0.0, 1.0);
  else {
    vec3 bl = texture(uBloom, vUv).rgb * uBloomNorm;
    c = aces(mix(hdr, bl, uBloomStr) * uExposure);
  }
  c = toSRGB(c);
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;   // дизеринг против полос
  fragColor = vec4(c, 1.0);
}
