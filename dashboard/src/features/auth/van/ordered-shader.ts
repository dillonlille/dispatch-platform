// Bayer 8×8 thresholds with the subtle temporal grain from the approved mockup.
export const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D sceneTexture;
  uniform float time, pixelSize;
  uniform vec2 resolution;
  varying vec2 vUv;
  float bayer2(vec2 p) { return mod(2.0 * p.x + 3.0 * p.y, 4.0); }
  float bayer8(vec2 p) {
    vec2 a = mod(p, 2.0), b = mod(floor(p / 2.0), 2.0), c = mod(floor(p / 4.0), 2.0);
    return (16.0 * bayer2(a) + 4.0 * bayer2(b) + bayer2(c) + 0.5) / 64.0;
  }
  float noise(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec4 color = texture2D(sceneTexture, vUv);
    vec3 rgb = pow(max(color.rgb, vec3(0.0)), vec3(1.0 / 2.2));
    float light = clamp((dot(rgb, vec3(0.2126, 0.7152, 0.0722)) - 0.1) * 1.06, 0.0, 0.97);
    vec2 cell = floor(vUv * resolution / pixelSize);
    float grain = (noise(cell + floor(time * 7.0)) - 0.5) * 0.055;
    float dots = step(bayer8(cell), clamp(light + grain, 0.0, 0.99)) * step(0.3, color.a);
    // White ink in both themes; transparent gaps reveal the CSS contour background.
    gl_FragColor = vec4(vec3(dots), dots);
  }
`;
