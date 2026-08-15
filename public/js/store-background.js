const JOINTS = [
  [0, 0, 0],
  [-1.2, -0.7, 0.25], [-2, -0.2, -0.1], [-2.35, 0.75, 0.45],
  [-1.55, 1.2, -0.4], [-0.65, 0.85, 0.3],
  [0.95, -0.9, -0.25], [1.85, -0.55, 0.35], [2.2, 0.35, -0.3],
  [1.45, 1, 0.25], [0.55, 0.65, -0.35],
  [-0.25, -1.25, 0.45], [0.4, -1.8, -0.25], [1.1, -1.6, 0.4],
  [-0.25, 1.3, -0.2], [-0.9, 1.95, 0.35], [0.15, 2.25, -0.45],
  [0.95, 1.75, 0.25], [-1.3, -1.5, -0.35], [-2.15, -1.3, 0.35],
  [1.65, 0.4, 0.8], [-1.6, 0.3, -0.9], [0.25, 0.25, 1], [-0.3, -0.3, -1],
];

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0],
  [0, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 0],
  [0, 11], [11, 12], [12, 13],
  [5, 14], [14, 15], [14, 16], [16, 17], [17, 9],
  [1, 18], [18, 19], [8, 20], [3, 21],
  [0, 22], [22, 20], [0, 23], [23, 21], [22, 16], [23, 12],
];

const DESKTOP_RIGS = [
  { x: 0.08, y: 0.3, scale: 0.085, phase: 0.3 },
  { x: 0.92, y: 0.28, scale: 0.08, phase: 2.5 },
  { x: 0.83, y: 0.82, scale: 0.07, phase: 4.4 },
];

const MOBILE_RIGS = [
  { x: 0.84, y: 0.3, scale: 0.1, phase: 2.5 },
  { x: 0.16, y: 0.82, scale: 0.085, phase: 4.4 },
];

function getPalette() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return dark
    ? { bone: '94, 214, 165', joint: '117, 232, 184', glow: '48, 177, 125', boneAlpha: 0.17, jointAlpha: 0.32 }
    : { bone: '15, 107, 77', joint: '18, 133, 92', glow: '52, 168, 123', boneAlpha: 0.11, jointAlpha: 0.23 };
}

function rotatePoint(point, time, phase) {
  let [x, y, z] = point;
  const distance = Math.min(1.4, Math.hypot(x, y) * 0.35);
  z += Math.sin(time * 0.00065 + phase + x * 1.3 + y * 1.7) * (0.06 + distance * 0.08);

  const yaw = time * 0.00008 + phase;
  const pitch = -0.14 + Math.sin(time * 0.00011 + phase) * 0.12;
  const roll = Math.sin(time * 0.00009 + phase) * 0.08;
  const yawX = x * Math.cos(yaw) - z * Math.sin(yaw);
  const yawZ = x * Math.sin(yaw) + z * Math.cos(yaw);
  const pitchY = y * Math.cos(pitch) - yawZ * Math.sin(pitch);
  const pitchZ = y * Math.sin(pitch) + yawZ * Math.cos(pitch);

  return [
    yawX * Math.cos(roll) - pitchY * Math.sin(roll),
    yawX * Math.sin(roll) + pitchY * Math.cos(roll),
    pitchZ,
  ];
}

function projectRig(rig, width, height, time) {
  const unit = Math.min(width, height) * rig.scale;
  return JOINTS.map((joint) => {
    const [x, y, z] = rotatePoint(joint, time, rig.phase);
    const perspective = 1 / (1 + z * 0.11);
    return {
      x: width * rig.x + x * unit * perspective,
      y: height * rig.y + y * unit * perspective,
      z,
      perspective,
    };
  });
}

function drawRig(context, points, colors) {
  BONES
    .map(([start, end]) => ({ start: points[start], end: points[end] }))
    .sort((a, b) => (a.start.z + a.end.z) - (b.start.z + b.end.z))
    .forEach(({ start, end }) => {
      const depth = Math.max(0.45, Math.min(1.35, (start.perspective + end.perspective) / 2));
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.lineWidth = 7 * depth;
      context.strokeStyle = `rgba(${colors.glow}, ${colors.boneAlpha * 0.12})`;
      context.stroke();
      context.lineWidth = 1.35 * depth;
      context.strokeStyle = `rgba(${colors.bone}, ${colors.boneAlpha * depth})`;
      context.stroke();
    });

  [...points].sort((a, b) => a.z - b.z).forEach((point) => {
    const radius = 3.2 * Math.max(0.72, Math.min(1.35, point.perspective));
    context.beginPath();
    context.arc(point.x, point.y, radius * 2.8, 0, Math.PI * 2);
    context.fillStyle = `rgba(${colors.glow}, ${colors.jointAlpha * 0.1})`;
    context.fill();
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(${colors.joint}, ${colors.jointAlpha * point.perspective})`;
    context.fill();
    context.lineWidth = 0.8;
    context.strokeStyle = `rgba(${colors.bone}, ${colors.jointAlpha * 0.75})`;
    context.stroke();
  });
}

export function mountStoreJointNetwork(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext('2d');
  if (!context) return;

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let width = 0;
  let height = 0;
  let colors = getPalette();

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw(time = 2400) {
    context.clearRect(0, 0, width, height);
    context.lineCap = 'round';
    const rigs = width <= 620 ? MOBILE_RIGS : DESKTOP_RIGS;
    rigs.forEach((rig) => drawRig(context, projectRig(rig, width, height, time), colors));
  }

  function animate(time) {
    draw(time);
    frame = requestAnimationFrame(animate);
  }

  function syncMotion() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (motionQuery.matches || document.hidden) draw();
    else frame = requestAnimationFrame(animate);
  }

  function handleResize() {
    resize();
    if (!frame) draw();
  }

  resize();
  syncMotion();
  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('kmxt:themechange', () => {
    colors = getPalette();
    if (!frame) draw();
  });
  document.addEventListener('visibilitychange', syncMotion);
  motionQuery.addEventListener?.('change', syncMotion);
}
