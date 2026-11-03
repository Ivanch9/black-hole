#version 300 es
// Пирамида размытия (dual filter): uUp = 0 — понижение, 1 — повышение с суммированием.
// Сумма размытий разных масштабов имитирует функцию рассеяния точки оптики (ореол).
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;   // размер текселя источника
uniform int uUp;

void main() {
  vec2 uv = vUv;
  vec3 c;
  if (uUp == 0) {
    vec2 h = uTexel;
    c = texture(uSrc, uv).rgb * 4.0
      + texture(uSrc, uv + vec2(-h.x, -h.y)).rgb + texture(uSrc, uv + vec2(h.x, -h.y)).rgb
      + texture(uSrc, uv + vec2(-h.x, h.y)).rgb + texture(uSrc, uv + vec2(h.x, h.y)).rgb;
    c /= 8.0;
  } else {
    vec2 h = uTexel;
    c = texture(uSrc, uv + vec2(-2.0 * h.x, 0.0)).rgb + texture(uSrc, uv + vec2(2.0 * h.x, 0.0)).rgb
      + texture(uSrc, uv + vec2(0.0, -2.0 * h.y)).rgb + texture(uSrc, uv + vec2(0.0, 2.0 * h.y)).rgb
      + 2.0 * (texture(uSrc, uv + vec2(-h.x, -h.y)).rgb + texture(uSrc, uv + vec2(h.x, -h.y)).rgb
             + texture(uSrc, uv + vec2(-h.x, h.y)).rgb + texture(uSrc, uv + vec2(h.x, h.y)).rgb);
    c /= 12.0;
  }
  fragColor = vec4(c, 1.0);
}
