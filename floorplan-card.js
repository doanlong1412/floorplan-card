/**
 * Floorplan Card cho Home Assistant
 * Vanilla JS custom element (không cần build tool) — chỉ cần copy file này
 * vào www/community/floorplan-card/ và khai báo resource.
 *
 * Tác giả: tạo theo yêu cầu, xem README.md để biết cách cài đặt & khai báo config.
 */

const CARD_TAG = 'home-floorplan-card';
const EDITOR_TAG = 'home-floorplan-card-editor';
const CARD_VERSION = '2.6.0';

console.info(
  `%c FLOORPLAN-CARD %c v${CARD_VERSION} `,
  'color:white;background:#03a9f4;font-weight:700;padding:2px 6px;border-radius:3px 0 0 3px;',
  'color:#03a9f4;background:transparent;font-weight:700;padding:2px 6px;border:1px solid #03a9f4;border-radius:0 3px 3px 0;',
);

/* ----------------------------- Helpers ----------------------------- */

function fireEvent(node, type, detail = {}, options = {}) {
  const event = new Event(type, {
    bubbles: options.bubbles !== undefined ? options.bubbles : true,
    cancelable: Boolean(options.cancelable),
    composed: options.composed !== undefined ? options.composed : true,
  });
  event.detail = detail;
  node.dispatchEvent(event);
  return event;
}

function isUnavailable(hass, entityId) {
  if (!entityId) return true;
  const st = hass && hass.states && hass.states[entityId];
  return !st || st.state === 'unavailable' || st.state === 'unknown';
}

function fmtNumber(hass, entityId, decimals) {
  if (isUnavailable(hass, entityId)) return '--';
  const st = hass.states[entityId];
  const num = parseFloat(st.state);
  if (Number.isNaN(num)) return st.state;
  return num.toFixed(decimals === undefined ? 1 : decimals);
}

// Ép về mảng an toàn: phòng trường hợp ai đó sửa tay YAML khiến light_entities
// thành string đơn lẻ thay vì list, khiến .forEach/.every/.some ném lỗi và
// làm gãy cả _render()/_computeHash().
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
}

function anyOn(hass, entityIds) {
  return toArray(entityIds).some((id) => hass && hass.states && hass.states[id] && hass.states[id].state === 'on');
}

function roomHasContent(room) {
  return !!(room.temp_entity || room.humidity_entity || toArray(room.light_entities).length);
}

// Đồng bộ hoá cổng & nút top-bar (đã bật vị trí riêng) với cơ chế 2 điểm
// (label_position + anchor_position) mà rooms đang dùng: nếu đã có "position"
// (điểm đặt thẻ) nhưng chưa có "anchor_position" (điểm chỉ tới trên ảnh), tự
// gán mặc định ngay phía trên 8% để luôn có đường kẻ + chấm neo hiển thị,
// đồng thời người dùng vẫn kéo chỉnh lại thoải mái trong "📍 Chỉnh vị trí".
function migrateAnchors(cfg) {
  const next = clone(cfg);
  if (next.gate && next.gate.position && !next.gate.anchor_position) {
    next.gate.anchor_position = { x: next.gate.position.x, y: Math.max(0, next.gate.position.y - 8) };
  }
  (next.top_bar_buttons || []).forEach((b) => {
    if (b.position && !b.anchor_position) {
      b.anchor_position = { x: b.position.x, y: Math.max(0, b.position.y - 8) };
    }
  });
  return next;
}

// Nội suy màu qua 3 điểm mốc (mát→vừa→nóng) theo tỉ lệ 0..1, dùng cho viền/
// glow của tag phòng: chỉ cần liếc màu là biết phòng nào đang nóng hơn, không
// cần đọc số. Dùng 3 stop (không phải 2) để có vùng "vừa" rõ ràng ở giữa thay
// vì chuyển thẳng xanh sang đỏ.
const TEMP_COLOR_STOPS = [
  { r: 79, g: 195, b: 247 },  // mát nhất trong dải hiện có — #4fc3f7
  { r: 255, g: 209, b: 102 }, // giữa dải — #ffd166
  { r: 255, g: 82, b: 82 },   // nóng nhất trong dải hiện có — #ff5252
];

function lerp(a, b, t) { return a + (b - a) * t; }

function tempColorForRatio(ratio) {
  const r = Math.min(1, Math.max(0, ratio));
  const [from, to, t] = r < 0.5
    ? [TEMP_COLOR_STOPS[0], TEMP_COLOR_STOPS[1], r / 0.5]
    : [TEMP_COLOR_STOPS[1], TEMP_COLOR_STOPS[2], (r - 0.5) / 0.5];
  return {
    r: Math.round(lerp(from.r, to.r, t)),
    g: Math.round(lerp(from.g, to.g, t)),
    b: Math.round(lerp(from.b, to.b, t)),
  };
}

// Ngưỡng tuyệt đối để bật hiệu ứng "nóng quá" (glow mạnh + nhấp nháy), tách
// biệt với gradient tương đối ở trên — vì gradient theo min/max chỉ cho biết
// phòng nào nóng HƠN các phòng khác trên cùng floorplan, không cho biết phòng
// đó có đang thực sự nóng hay không (vd mùa đông, phòng nóng nhất vẫn có thể
// chỉ 24°C, không đáng để nhấp nháy cảnh báo).
const ROOM_HOT_THRESHOLD_C = 28;

// Gom nhiệt độ hợp lệ (số, không unavailable/unknown) của các phòng đang hiển
// thị để tính min/max cho gradient màu. Cần tối thiểu 2 giá trị khác nhau —
// nếu chỉ 1 phòng có cảm biến, hoặc tất cả bằng nhau, trả về null để
// _roomTemplate giữ nguyên viền màu mặc định (không có gì để so sánh).
function computeRoomTempRange(rooms, hass) {
  const temps = rooms
    .map((r) => ((r.temp_entity && !isUnavailable(hass, r.temp_entity))
      ? parseFloat(hass.states[r.temp_entity].state) : NaN))
    .filter((t) => !Number.isNaN(t));
  if (temps.length < 2) return null;
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  if (max - min < 0.1) return null; // các phòng gần như cùng nhiệt độ -> không có gì để tô gradient
  return { min, max };
}

// Giải hệ phương trình tuyến tính A·x = b bằng khử Gauss có chọn pivot (số
// lớn nhất theo trị tuyệt đối ở mỗi cột) để giảm sai số làm tròn số thực.
// Trả về null nếu ma trận suy biến (ví dụ các điểm hiệu chỉnh thẳng hàng /
// trùng nhau -> không đủ thông tin để giải).
function gaussianSolve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => row.slice().concat(b[i]));
  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > maxAbs) { maxAbs = Math.abs(M[r][col]); pivotRow = r; }
    }
    if (maxAbs < 1e-9) return null;
    if (pivotRow !== col) { const tmp = M[col]; M[col] = M[pivotRow]; M[pivotRow] = tmp; }
    const pivot = M[col][col];
    for (let c = col; c <= n; c += 1) M[col][c] /= pivot;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

// Tính ma trận homography (phép biến đổi phối cảnh 3x3, h33 cố định = 1) từ
// N>=4 cặp điểm tương ứng (toạ độ robot -> toạ độ % trên ảnh). Với N=4 đây là
// nghiệm đúng tuyệt đối; với N>4 dùng least-squares (normal equations
// A^T·A·x = A^T·b) để "trung bình hoá" sai số vẽ tay giữa các điểm, thay vì
// chỉ khớp đúng 4 điểm đầu và bỏ qua phần còn lại. Khác với scale tuyến tính
// 2 điểm theo từng trục (X/Y độc lập) mà bản cũ dùng, homography xử lý được
// cả xoay và nghiêng phối cảnh -> phù hợp để chiếu bản đồ top-down 2D của
// robot lên ảnh floorplan phối cảnh 3D/isometric.
function computeHomography(pts) {
  const M = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const v = new Array(8).fill(0);
  const addRow = (row, target) => {
    for (let i = 0; i < 8; i += 1) {
      v[i] += row[i] * target;
      for (let j = 0; j < 8; j += 1) M[i][j] += row[i] * row[j];
    }
  };
  pts.forEach((p) => {
    const { rx, ry, ix, iy } = p;
    addRow([rx, ry, 1, 0, 0, 0, -rx * ix, -ry * ix], ix);
    addRow([0, 0, 0, rx, ry, 1, -rx * iy, -ry * iy], iy);
  });
  const sol = gaussianSolve(M, v);
  if (!sol) return null;
  const [h11, h12, h13, h21, h22, h23, h31, h32] = sol;
  return { h11, h12, h13, h21, h22, h23, h31, h32 };
}

function applyHomography(H, rx, ry) {
  const denom = H.h31 * rx + H.h32 * ry + 1;
  if (Math.abs(denom) < 1e-9) return null;
  return {
    x: (H.h11 * rx + H.h12 * ry + H.h13) / denom,
    y: (H.h21 * rx + H.h22 * ry + H.h23) / denom,
  };
}

function escapeHtml(str) {
  return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------ Styles ------------------------------ */

const STYLE = `
  :host { display:block; }
  ha-card { overflow:hidden; padding:0; background:#000; }
  .wrapper { position:relative; width:100%; aspect-ratio: var(--fp-aspect, 16/9); min-height:220px; overflow:hidden;
    border-radius:14px; background:#000; font-family: var(--paper-font-body1_-_font-family, "Segoe UI", Roboto, sans-serif); }
  .bg-image { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; user-select:none; }
  .overlay-svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  .anchor-line { stroke: rgba(120,224,255,0.6); stroke-width:1.5; filter: drop-shadow(0 0 3px rgba(90,210,255,.65)); }
  .anchor-dot { fill:#7fe3ff; opacity:.95; filter: drop-shadow(0 0 5px rgba(90,210,255,.95)); }
  /* Vệt đường đi robot: cùng tông cyan với robot-marker để đồng bộ theme.
     opacity được set INLINE (không phải qua class) vì thay đổi theo từng lượt
     render — xem _robotTrailSvgTemplate(). transition giúp mỗi lần opacity
     giảm dần (qua timer 7s) trông mượt thay vì "nhảy khấc" theo bậc thang. */
  .robot-trail { fill:none; stroke: rgba(120,224,255,0.85); stroke-width:2.5;
    stroke-linecap:round; stroke-linejoin:round;
    filter: drop-shadow(0 0 3px rgba(90,210,255,.55));
    transition: opacity 1.2s linear; }
  .room-label { position:absolute; transform:translate(-50%,-100%);
    background:linear-gradient(180deg, rgba(11,24,36,0.82), rgba(6,14,22,0.9));
    border:1px solid var(--room-border-color, rgba(120,224,255,0.45)); border-radius:10px; padding:8px 12px 7px; color:#fff; min-width:120px;
    box-shadow: 0 0 14px var(--room-glow-color, rgba(70,190,255,0.25)), inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 16px rgba(0,0,0,0.55);
    backdrop-filter: blur(9px); -webkit-backdrop-filter: blur(9px);
    transition: border-color .5s ease, box-shadow .5s ease; }
  /* Viền/glow nội suy theo nhiệt độ (xem tempColorForRatio) được set qua
     --room-border-color / --room-glow-color inline trên từng thẻ phòng.
     Khi vượt ROOM_HOT_THRESHOLD_C, thêm class .temp-hot để glow mạnh + nhấp
     nháy nhẹ, tách biệt "nóng hơn phòng khác" (màu) và "nóng thật sự" (nhấp nháy). */
  .room-label.temp-hot { animation: roomHotPulse 1.7s ease-in-out infinite; }
  @keyframes roomHotPulse {
    0%, 100% { box-shadow: 0 0 16px var(--room-glow-color, rgba(255,82,82,.5)), inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 16px rgba(0,0,0,0.55); }
    50% { box-shadow: 0 0 32px var(--room-glow-color, rgba(255,82,82,.85)), inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 16px rgba(0,0,0,0.55); }
  }
  .room-head { display:flex; align-items:center; gap:6px; margin-bottom:3px; }
  .room-head ha-icon { --mdc-icon-size:15px; color:#7fe3ff; opacity:1; filter: drop-shadow(0 0 4px rgba(90,210,255,.8)); flex-shrink:0; }
  .room-name { font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; opacity:.94; cursor:pointer; white-space:nowrap; }
  .room-meta { display:flex; gap:8px; margin-top:2px; flex-wrap:wrap; }
  .chip { display:flex; align-items:center; gap:3px; font-size:12px; color:#e8e8ec; }
  .chip ha-icon { --mdc-icon-size:14px; opacity:.85; }
  .chip.metric ha-icon { color:#7fe3ff; opacity:1; filter: drop-shadow(0 0 3px rgba(90,210,255,.6)); }
  .chip.toggle { cursor:pointer; }
  .chip.toggle.on ha-icon { color:#ffd166; opacity:1; }
  .chip.dimmed { opacity:.4; }
  .gate-widget { position:absolute; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; }
  .gate-card { display:flex; flex-direction:column; align-items:center; gap:9px;
    background:linear-gradient(180deg, rgba(11,24,36,0.5), rgba(6,14,22,0.58));
    border:1px solid rgba(120,224,255,0.4); border-radius:14px; padding:10px 14px 12px;
    box-shadow: 0 0 14px rgba(70,190,255,0.18), inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 18px rgba(0,0,0,0.4);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); min-width:132px; }
  .gate-head { display:flex; align-items:center; gap:8px; align-self:flex-start; }
  .gate-head ha-icon { --mdc-icon-size:18px; color:#7fe3ff; filter: drop-shadow(0 0 4px rgba(90,210,255,.8)); flex-shrink:0; }
  .gate-title { font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; color:#fff; white-space:nowrap; }
  .gate-status { font-size:9.5px; opacity:.75; color:#bfe9ff; text-transform:uppercase; letter-spacing:.02em; margin-top:1px; }
  .gate-slide-track { position:relative; width:176px; height:34px; border-radius:20px; overflow:hidden;
    border:1px solid rgba(120,224,255,0.5); background:rgba(120,224,255,0.08);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.1), 0 0 10px rgba(70,190,255,0.2); touch-action:none; }
  .gate-slide-label { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:4px;
    color:#dff5ff; font-size:9.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase;
    white-space:nowrap; pointer-events:none; user-select:none; }
  .gate-slide-label ha-icon.chev { --mdc-icon-size:13px; color:#7fe3ff; opacity:.35;
    animation: gateChevBlink 1.3s ease-in-out infinite; }
  .gate-slide-label ha-icon.chev:last-child { animation-delay:.25s; }
  @keyframes gateChevBlink { 0%,100% { opacity:.25; transform:translateX(0); } 50% { opacity:1; transform:translateX(var(--chev-dir,0)); } }
  .gate-slide-thumb { position:absolute; top:50%; left:2px; margin-top:-14px; width:28px; height:28px; border-radius:50%;
    box-sizing:border-box;
    background:linear-gradient(180deg, rgba(150,232,255,0.45), rgba(120,224,255,0.15));
    border:1px solid rgba(150,232,255,0.7); display:flex; align-items:center; justify-content:center;
    cursor:grab; touch-action:none; z-index:2;
    box-shadow:0 2px 6px rgba(0,0,0,0.4), 0 0 10px rgba(90,210,255,0.55);
    transition: background .2s ease, border-color .2s ease, box-shadow .2s ease; }
  .gate-slide-thumb:active { cursor:grabbing; }
  /* Trạng thái "đã xác nhận" — thumb giữ nguyên tại vị trí vừa kéo tới trong
     lúc chờ trở về giữa (xem HOLD_MS trong _bindGateSlideNeutral), đổi màu
     xanh lá để người dùng biết chắc lệnh đã được ghi nhận, tránh cảm giác
     "không biết đã bấm trúng chưa" khi thumb tự trượt về ngay lập tức. */
  .gate-slide-thumb.confirmed { background:linear-gradient(180deg, rgba(139,209,124,0.55), rgba(139,209,124,0.18));
    border-color:rgba(139,209,124,0.85); box-shadow:0 2px 6px rgba(0,0,0,0.4), 0 0 12px rgba(139,209,124,0.75); }
  /* Vị trí "nghỉ" (chưa kéo) định bằng CSS thuần theo trạng thái — KHÔNG tính
     bằng JS lúc bind nữa. Trước đây JS đo track.clientWidth ngay sau khi set
     innerHTML để tính centerLeft; nếu card chưa thực sự visible tại thời điểm
     đó (lượt render đầu, hoặc đang ở tab/view dashboard chưa active),
     clientWidth trả về 0 và code rơi vào fallback ước lượng sai kích thước
     thật (176px trong CSS vs fallback 150px trong JS) -> thumb bị lệch tâm
     vĩnh viễn vì không có gì tính lại sau đó. CSS luôn đúng ngay khi phần tử
     có layout thật, bất kể JS chạy sớm hay muộn. */
  .gate-slide-track[data-open="1"] .gate-slide-thumb { left:2px; right:auto; }
  .gate-slide-track[data-open="0"] .gate-slide-thumb { left:auto; right:2px; }
  .gate-slide-track.neutral .gate-slide-thumb { left:50%; right:auto; margin-left:-14px; }
  .gate-slide-thumb ha-icon { --mdc-icon-size:15px; color:#eafcff; pointer-events:none; }
  /* Track trung tính (không biết trạng thái hiện tại) — thumb bắt đầu ở giữa,
     vuốt trái = mở, vuốt phải = đóng, buông giữa chừng tự trượt về giữa.
     Nhãn "Mở"/"Đóng" phải dồn hẳn ra 2 mép (space-between + padding), KHÔNG
     đặt giữa track, để thumb tròn ở tâm không bao giờ đè lên chữ. */
  .gate-slide-track.neutral { background: linear-gradient(90deg, rgba(90,210,255,0.05), rgba(90,210,255,0.16) 50%, rgba(90,210,255,0.05)); }
  .gate-slide-track.neutral::after { content:''; position:absolute; left:50%; top:5px; bottom:5px; width:1px;
    background:rgba(120,224,255,0.4); transform:translateX(-50%); }
  .gate-slide-track.neutral .gate-slide-label { justify-content:space-between; padding:0 10px; gap:0; }
  .gate-slide-track.neutral .gate-slide-label .side { display:flex; align-items:center; gap:3px; }
  .gate-slide-label .sep { opacity:.4; margin:0 1px; }
  /* Hàng điều khiển chính: track vuốt + (tuỳ chọn) nút Dừng nhỏ đặt ngay cạnh,
     thay vì chiếm nguyên 1 hàng riêng bên dưới -> đỡ tốn diện tích. */
  .gate-control-row { display:flex; align-items:center; gap:6px; }
  .gate-stop-mini { flex-shrink:0; width:30px; height:30px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    background:rgba(255,138,128,0.12); border:1px solid rgba(255,138,128,0.5);
    cursor:pointer; touch-action:manipulation; user-select:none; }
  .gate-stop-mini:active { background:rgba(255,138,128,0.32); transform:scale(.92); }
  .gate-stop-mini ha-icon { --mdc-icon-size:16px; color:#ff8a80; filter: drop-shadow(0 0 4px rgba(255,138,128,.8)); }
  /* Fallback khi chỉ có 1 trong 2 chiều mở/đóng (thiếu entity đối lập) — vẫn
     dùng nút chữ nhật to hơn vì lúc đó không có track vuốt để đặt cạnh. */
  .gate-btn-row { display:flex; gap:8px; }
  .gate-btn { display:flex; flex-direction:column; align-items:center; gap:4px; min-width:44px;
    background:rgba(120,224,255,0.1); border:1px solid rgba(120,224,255,0.45); border-radius:10px;
    padding:8px 10px 7px; color:#dff5ff; font-size:9px; font-weight:700; letter-spacing:.03em;
    text-transform:uppercase; cursor:pointer; touch-action:manipulation; user-select:none; }
  .gate-btn:active { background:rgba(120,224,255,0.3); transform:scale(.95); }
  .gate-btn ha-icon { --mdc-icon-size:18px; color:#7fe3ff; filter: drop-shadow(0 0 4px rgba(90,210,255,.8)); }

  .robot-marker { position:absolute; transform:translate(-50%,-50%); width:26px; height:26px; border-radius:50%;
    display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:6;
    background:linear-gradient(180deg, rgba(150,232,255,0.5), rgba(120,224,255,0.2));
    border:1px solid rgba(150,232,255,0.75);
    box-shadow:0 2px 8px rgba(0,0,0,0.45), 0 0 10px rgba(90,210,255,0.6);
    transition: left .9s linear, top .9s linear; }
  .robot-marker ha-icon { --mdc-icon-size:15px; color:#eafcff; filter: drop-shadow(0 0 3px rgba(90,210,255,.8)); }
  .robot-pulse { position:absolute; inset:-8px; border-radius:50%; border:1.5px solid rgba(120,224,255,0.65);
    opacity:0; }
  .robot-marker.active .robot-pulse { animation: robotPulse 1.6s ease-out infinite; }
  @keyframes robotPulse { 0% { transform:scale(.6); opacity:.8; } 100% { transform:scale(1.9); opacity:0; } }

  .robot-tag { position:absolute; left:20px; top:50%; transform:translateY(-50%); white-space:nowrap;
    background:rgba(15,18,25,0.78); border:1px solid rgba(120,224,255,0.4); border-radius:6px; padding:3px 8px;
    font-size:10px; font-weight:600; color:#dff5ff; opacity:0; pointer-events:none; backdrop-filter:blur(6px);
    animation: robotTagBlink 12s ease-in-out infinite; z-index:7; }
  @keyframes robotTagBlink { 0%, 80% { opacity:0; } 87%, 95% { opacity:1; } 100% { opacity:0; } }

  .robot-bubble { position:absolute; left:50%; bottom:100%; transform:translate(-50%,-9px); white-space:nowrap;
    display:flex; align-items:center; gap:4px; background:rgba(15,18,25,0.88);
    border:1px solid rgba(120,224,255,0.45); border-radius:10px; padding:4px 9px 4px 7px;
    font-size:11px; font-weight:600; color:#fff; box-shadow:0 4px 12px rgba(0,0,0,0.45); pointer-events:none; z-index:8; }
  .robot-bubble::after { content:''; position:absolute; top:100%; left:50%; transform:translateX(-50%);
    border:5px solid transparent; border-top-color:rgba(15,18,25,0.88); }
  .robot-bubble-emoji { font-size:13px; line-height:1; display:inline-block; }

  /* Cleaning: chổi phẩy qua lại + bụi bay ra */
  .robot-bubble.mood-clean { overflow:visible; }
  .robot-bubble.mood-clean .robot-bubble-emoji { animation: sweepBroom .6s ease-in-out infinite; transform-origin:70% 85%; }
  @keyframes sweepBroom { 0%,100% { transform:rotate(-16deg); } 50% { transform:rotate(16deg); } }
  .dust-mote { position:absolute; width:3px; height:3px; border-radius:50%; background:#dfe8ee; opacity:0; bottom:3px; left:10px; }
  .dust-mote.d1 { animation: dustFly 1s ease-out infinite; }
  .dust-mote.d2 { left:16px; animation: dustFly 1s ease-out .3s infinite; }
  .dust-mote.d3 { left:22px; animation: dustFly 1s ease-out .6s infinite; }
  @keyframes dustFly { 0% { opacity:0; transform:translate(0,0) scale(1); } 20% { opacity:.9; } 100% { opacity:0; transform:translate(-9px,9px) scale(.4); } }

  /* Mopping: giọt nước lắc nhẹ như đang lau */
  .robot-bubble.mood-mop .robot-bubble-emoji { animation: dropWiggle .8s ease-in-out infinite; }
  @keyframes dropWiggle { 0%,100% { transform:translateY(0) rotate(0); } 50% { transform:translateY(2px) rotate(-10deg); } }

  /* Sleeping: gật gù + trôi bồng bềnh */
  .robot-bubble.mood-sleep { animation: robotFloat 2.4s ease-in-out infinite; }
  .robot-bubble.mood-sleep .robot-bubble-emoji { animation: sleepNod 2.4s ease-in-out infinite; transform-origin:50% 80%; }
  @keyframes robotFloat { 0%,100% { transform:translate(-50%,-9px); } 50% { transform:translate(-50%,-15px); } }
  @keyframes sleepNod { 0%,100% { transform:rotate(0deg); } 50% { transform:rotate(-10deg); } }

  /* Charging: pin nhấp nháy như đang nạp điện */
  .robot-bubble.mood-charge .robot-bubble-emoji { animation: chargeBlink 1s steps(2) infinite; }
  @keyframes chargeBlink { 0%,49% { opacity:1; } 50%,100% { opacity:.35; } }
  /* Sạc đầy: thở nhẹ nhàng, mãn nguyện */
  .robot-bubble.mood-charged { animation: breathe 2.8s ease-in-out infinite; }

  /* Đang về sạc: hơi lắc như đang di chuyển */
  .robot-bubble.mood-return { animation: returnShake .5s ease-in-out infinite; }
  @keyframes returnShake { 0%,100% { transform:translate(-50%,-9px) translateX(0); } 50% { transform:translate(-50%,-9px) translateX(2px); } }

  /* Tạm dừng: nhấp nháy mờ chậm rãi */
  .robot-bubble.mood-pause { animation: pauseBlink 1.6s ease-in-out infinite; }
  @keyframes pauseBlink { 0%,100% { opacity:1; } 50% { opacity:.4; } }

  /* Đầy hộp rác: nảy nhẹ liên tục để gây chú ý */
  .robot-bubble.mood-full { animation: bounceFull .9s ease-in-out infinite; }
  @keyframes bounceFull { 0%,100% { transform:translate(-50%,-9px); } 50% { transform:translate(-50%,-16px); } }

  /* Lỗi: lắc mạnh báo động */
  .robot-bubble.mood-error { border-color:rgba(240,120,120,0.6); background:rgba(60,14,14,0.9); animation: errorShake .4s ease-in-out infinite; }
  .robot-bubble.mood-error::after { border-top-color:rgba(60,14,14,0.9); }
  @keyframes errorShake { 0%,100% { transform:translate(-50%,-9px) rotate(0deg); } 25% { transform:translate(-50%,-9px) rotate(-7deg); } 75% { transform:translate(-50%,-9px) rotate(7deg); } }

  /* Mất kết nối: chớp tắt chập chờn như tín hiệu yếu */
  .robot-bubble.mood-offline { border-color:rgba(150,150,150,0.5); animation: offlineFlicker 1.8s steps(1) infinite; }
  @keyframes offlineFlicker { 0%,55%,100% { opacity:1; } 60%,72% { opacity:.2; } }

  /* Đang chờ (idle): thở nhẹ, sống động nhưng không ồn ào */
  .robot-bubble.mood-idle-wait { animation: breathe 2.6s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { transform:translate(-50%,-9px) scale(1); opacity:.85; } 50% { transform:translate(-50%,-9px) scale(1.07); opacity:1; } }

  /* Standby: mờ dần đều đặn, chậm hơn idle, như đang lim dim nghỉ */
  .robot-bubble.mood-standby { animation: standbyDim 3.4s ease-in-out infinite; }
  @keyframes standbyDim { 0%,100% { opacity:.5; } 50% { opacity:1; } }
  .top-bar { position:absolute; top:12px; right:12px; display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
  .top-btn { display:flex; align-items:center; gap:6px; background:rgba(15,18,25,0.55); backdrop-filter:blur(8px);
    border:1px solid rgba(255,255,255,0.14); color:#fff; border-radius:8px; padding:6px 10px; font-size:11px;
    font-weight:600; cursor:pointer; text-transform:uppercase; }
  .top-btn ha-icon { --mdc-icon-size:16px; }
  .top-btn--free { position:absolute; transform:translate(-50%,-50%); z-index:5; }
  .scenes-panel { position:absolute; bottom:12px; right:12px; background:rgba(15,18,25,0.55); backdrop-filter:blur(8px);
    border:1px solid rgba(255,255,255,0.14); border-radius:10px; padding:8px; }
  .scenes-title { font-size:9px; color:#fff; opacity:.65; margin-bottom:6px; text-transform:uppercase; text-align:center; }
  .scenes-grid { display:flex; gap:8px; }
  .scene-btn { position:relative; z-index:0; overflow:hidden; display:flex; flex-direction:column; align-items:center; gap:4px;
    background:rgba(255,255,255,0.07); border:none; color:#fff; border-radius:8px; padding:8px 6px; cursor:pointer;
    font-size:9px; width:54px; transition:background .25s ease, color .25s ease; }
  .scene-btn ha-icon { --mdc-icon-size:18px; }
  /* Kích hoạt: viền sáng XOAY LIÊN TỤC quanh nút (2 vệt đối xứng, kiểu ánh
     kim cương chạy quanh viền), báo hiệu "đã bấm, đang chạy kịch bản" (hoặc
     với automation: đang bật). Kỹ thuật: 1 hình vuông to phủ conic-gradient
     (::before) đặt phía sau nút và xoay bằng transform:rotate — bị "cắt gọn"
     vừa khít theo overflow:hidden + border-radius của chính nút; phía trên nó
     phủ 1 lớp nền gần kín (::after) chỉ chừa lại đúng viền mỏng, nên chỉ có
     viền là thấy đang xoay. Cố tình KHÔNG dùng @property + custom-property
     animation (cách làm trước) vì nhiều webview (đặc biệt app HA companion)
     không hỗ trợ, khiến viền bị đứng im dù animation vẫn "chạy". transform:
     rotate() thì gần như trình duyệt/webview nào cũng chạy được. */
  .scene-btn--active { color:#eafcff; }
  .scene-btn--active::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 220%;
    height: 220%;
    background: conic-gradient(from 0deg,
      transparent 0deg, transparent 70deg,
      #7be3ff 90deg,
      transparent 110deg, transparent 250deg,
      #7be3ff 270deg,
      transparent 290deg, transparent 360deg);
    transform: translate(-50%, -50%) rotate(0deg);
    animation: sceneBorderSpin 1.6s linear infinite;
    z-index: -2;
  }
  .scene-btn--active::after {
    content: '';
    position: absolute;
    inset: 2px;
    border-radius: 7px;
    /* Nền sáng, ĐỨNG IM (không animation) — chỉ viền (::before) mới xoay */
    background: linear-gradient(180deg, rgba(58,168,214,0.55), rgba(24,96,128,0.6));
    z-index: -1;
  }
  @keyframes sceneBorderSpin { to { transform: translate(-50%, -50%) rotate(360deg); } }
  .status-bar { position:absolute; left:12px; bottom:12px; display:flex; gap:8px; flex-wrap:wrap; max-width:calc(100% - 24px); }
  .status-item { display:flex; align-items:center; gap:6px; background:rgba(15,18,25,0.55); backdrop-filter:blur(8px);
    border:1px solid rgba(255,255,255,0.14); border-radius:20px; padding:6px 12px 6px 8px; color:#fff; cursor:pointer;
    box-shadow:0 3px 8px rgba(0,0,0,.35); min-width:0; }
  .status-item ha-icon { opacity:.85; --mdc-icon-size:16px; flex-shrink:0; }
  .status-value { font-size:12px; font-weight:700; white-space:nowrap; }

  .media-bar { display:flex; align-items:center; gap:6px; background:rgba(15,18,25,0.55); backdrop-filter:blur(8px);
    border:1px solid rgba(120,224,255,0.4); border-radius:20px; padding:5px; box-shadow:0 3px 8px rgba(0,0,0,.35); }
  .media-bar-toggle { width:34px; height:34px; border-radius:50%; border:none; flex-shrink:0; cursor:pointer; padding:0;
    background:linear-gradient(180deg, rgba(120,224,255,.4), rgba(120,224,255,.14));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.15), 0 0 8px rgba(90,210,255,.35);
    display:flex; align-items:center; justify-content:center; transition: background .25s ease; }
  .media-bar-toggle ha-icon { --mdc-icon-size:18px; color:#eafcff; }
  .media-bar.open .media-bar-toggle { background:linear-gradient(180deg, rgba(255,140,160,.45), rgba(255,140,160,.16)); }
  .media-bar-buttons { display:flex; align-items:center; gap:6px; max-width:0; overflow:hidden; opacity:0;
    transition: max-width .35s cubic-bezier(.4,0,.2,1), opacity .22s ease; }
  .media-bar.open .media-bar-buttons { max-width:220px; opacity:1; }
  .media-bar-btn { width:26px; height:26px; border-radius:50%; border:1px solid rgba(120,224,255,.4); cursor:pointer; padding:0;
    background:rgba(120,224,255,.1); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .media-bar-btn ha-icon { --mdc-icon-size:14px; color:#7fe3ff; filter: drop-shadow(0 0 3px rgba(90,210,255,.6)); }
  .empty-state { padding:24px; color:#aaa; text-align:center; }
  .popup-backdrop { position:absolute; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center;
    justify-content:center; z-index:20; padding:24px; box-sizing:border-box; }
  .popup-box { background:rgba(20,22,28,0.95); backdrop-filter:blur(10px); border:1px solid rgba(255,255,255,0.14);
    border-radius:14px; max-width:min(420px,100%); max-height:100%; overflow:auto; box-shadow:0 10px 30px rgba(0,0,0,0.55); }
  .popup-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 16px; }
  .popup-title { color:#fff; font-size:15px; font-weight:700; }
  .popup-close-btn { background:rgba(255,255,255,0.08); border:none; color:#fff; width:26px; height:26px; border-radius:50%;
    cursor:pointer; font-size:13px; flex-shrink:0; }
  .popup-image { display:block; width:100%; max-height:220px; object-fit:cover; }
  .popup-content { padding:0 16px 16px; color:#e8e8ec; font-size:13px; line-height:1.6; }
  .popup-backdrop--camera { padding:16px; }
  .popup-camera-box { position:relative; max-width:min(380px,92vw); max-height:88%; border-radius:12px; overflow:hidden;
    background:#000; line-height:0; box-shadow:0 10px 30px rgba(0,0,0,0.6); }
  .popup-camera-img { display:block; width:100%; height:auto; max-height:80vh; object-fit:contain; }
  .popup-camera-close { position:absolute; top:6px; right:6px; background:rgba(0,0,0,0.55); border:none; color:#fff;
    width:24px; height:24px; border-radius:50%; cursor:pointer; font-size:12px; z-index:2; line-height:24px; padding:0; }
  .popup-camera-fallback { color:#ccc; padding:32px; font-size:12px; text-align:center; line-height:1.5; }
`;

/* ---------------------------- Main Card ---------------------------- */

class FloorplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._lastHash = null;
    this._clickBound = false;
    this._resizeObserver = null;
    this._contentPopup = null;
    this._mediaBarOpen = false;
    // --- Hiệu ứng "đang kích hoạt" cho nút kịch bản nhanh (scenes) ---
    // _activeScenes: Set các index nút scene đang hiển thị hiệu ứng glow xoay
    // viền; _scenePulseTimers: timer tắt hiệu ứng tương ứng theo từng index, để
    // bấm lại trong lúc đang glow sẽ reset lại đủ thời lượng thay vì cộng dồn.
    this._activeScenes = new Set();
    this._scenePulseTimers = {};
    // --- Trail (vệt đường đi của robot) ---
    // _robotTrailPoints: mảng {x, y} (% trên ảnh) đã ghi trong phiên dọn hiện tại.
    // _robotTrailPrevVacuumState: state trước đó của robot.vacuum_entity, để phát
    // hiện đúng thời điểm CHUYỂN sang "cleaning" (reset) hoặc chuyển sang
    // "docked"/"idle" (đánh dấu hoàn tất, bắt đầu đếm mờ dần).
    // _robotTrailCompletedAt: mốc thời gian (ms) lúc phát hiện hoàn tất, null nếu
    // đang dọn hoặc chưa từng dọn.
    // _robotTrailFadeTimer: setInterval riêng để re-render mượt trong lúc đếm mờ
    // dần — vì lúc này attribute vị trí của camera.entity thường đứng yên, không
    // có gì kích hoạt set hass() nữa.
    // _robotTrailDay: "YYYY-M-D" (giờ local) của lần _updateRobotTrail gần nhất
    // -> phát hiện sang ngày mới để xoá sạch vệt (không giữ vệt qua ngày), và
    // cũng là mốc "đầu ngày" dùng khi query History API lúc khôi phục.
    this._robotTrailPoints = [];
    this._robotTrailPrevVacuumState = null;
    this._robotTrailCompletedAt = null;
    this._robotTrailFadeTimer = null;
    this._robotTrailDay = null;
    // (thường xảy ra khi resource JS load chậm), giá trị đó nằm ở dạng "own property"
    // thường và sẽ CHE MẤT setter `set hass()` bên dưới => card không bao giờ render.
    // Đoạn dưới đây "giải phóng" property đó và gán lại thông qua setter thật.
    this._upgradeProperty('hass');
  }

  _upgradeProperty(prop) {
    if (Object.prototype.hasOwnProperty.call(this, prop)) {
      const value = this[prop];
      delete this[prop];
      this[prop] = value;
    }
  }

  setConfig(config) {
    if (!config) throw new Error('Thiếu cấu hình cho floorplan-card.');
    if (!config.background_image) {
      throw new Error('Cần khai báo "background_image" (đường dẫn ảnh nền, ví dụ /local/floorplan/house.png).');
    }
    if (config.rooms !== undefined && !Array.isArray(config.rooms)) {
      throw new Error('"rooms" phải là danh sách (array).');
    }
    (config.rooms || []).forEach((r, i) => {
      if (!r.id) throw new Error(`Room #${i + 1} thiếu trường "id".`);
      if (!r.name) throw new Error(`Room "${r.id}" thiếu trường "name".`);
    });
    this._config = migrateAnchors({
      aspect_ratio: '16/9',
      rooms: [],
      top_bar_buttons: [],
      scenes: [],
      status_bar: [],
      ...config,
    });
    this._lastHash = null;
    this._renderFailed = false;
    if (this._hass) {
      if (this._safeRender()) this._lastHash = this._computeHash();
      else this._renderFailed = true;
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    // Nếu lần render trước đó bị lỗi (this._renderFailed), luôn thử render lại
    // ở lần hass tiếp theo bất kể hash có đổi hay không — tránh việc card bị
    // "đóng băng" ở trạng thái trống vì _lastHash đã trót ghi nhận giá trị cũ.
    const hash = this._computeHash();
    if (hash !== this._lastHash || this._renderFailed) {
      const ok = this._safeRender();
      // QUAN TRỌNG: chỉ chốt _lastHash khi render thực sự thành công. Nếu render
      // throw (race lúc hass/states chưa sẵn sàng, ha-icon/ha-card chưa upgrade...),
      // KHÔNG được ghi _lastHash = hash, nếu không lần cập nhật hass kế tiếp với
      // cùng hash sẽ bị bỏ qua (điều kiện != false) và card mất vĩnh viễn cho tới
      // khi có entity liên quan đổi state hoặc F5 lại trang.
      if (ok) {
        this._lastHash = hash;
        this._renderFailed = false;
      } else {
        this._renderFailed = true;
      }
    }
  }

  /** Bọc _render() để 1 lỗi transient không làm card biến mất vĩnh viễn. */
  _safeRender() {
    try {
      this._render();
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[floorplan-card] Lỗi khi render, sẽ tự thử lại ở lần cập nhật hass kế tiếp:', err);
      if (this.shadowRoot) {
        this.shadowRoot.innerHTML = `
          <style>${STYLE}</style>
          <ha-card>
            <div class="empty-state">
              ⚠️ floorplan-card gặp lỗi khi vẽ card, đang tự thử lại...<br />
              <span style="font-size:10px;opacity:.7">${escapeHtml(err && err.message ? err.message : String(err))}</span>
            </div>
          </ha-card>`;
      }
      return false;
    }
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    // Khi element được gắn (lại) vào DOM (đổi view, kéo-thả lại card, v.v...),
    // luôn thử render lại nếu lần trước đó thất bại, kể cả khi hash chưa đổi.
    if (this._config && this._hass && (this._renderFailed || !this._lastHash)) {
      if (this._safeRender()) {
        this._lastHash = this._computeHash();
        this._renderFailed = false;
      } else {
        this._renderFailed = true;
      }
    }
  }

  disconnectedCallback() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._robotTrailFadeTimer) { clearInterval(this._robotTrailFadeTimer); this._robotTrailFadeTimer = null; }
    if (this._scenePulseTimers) {
      Object.values(this._scenePulseTimers).forEach((t) => clearTimeout(t));
      this._scenePulseTimers = {};
    }
  }

  getCardSize() {
    return 6;
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return DEFAULT_STUB_CONFIG;
  }

  /* -------- shouldUpdate-style hash: chỉ những entity đã khai báo -------- */
  _computeHash() {
    if (!this._hass || !this._config) return null;
    try {
      const parts = [];
      (this._config.rooms || []).forEach((r) => {
        if (r.temp_entity) parts.push(this._hass.states[r.temp_entity] && this._hass.states[r.temp_entity].state);
        if (r.humidity_entity) parts.push(this._hass.states[r.humidity_entity] && this._hass.states[r.humidity_entity].state);
        toArray(r.light_entities).forEach((e) => parts.push(this._hass.states[e] && this._hass.states[e].state));
      });
      if (this._config.gate && this._config.gate.entity) {
        parts.push(this._hass.states[this._config.gate.entity] && this._hass.states[this._config.gate.entity].state);
      }
      if (this._config.gate && this._config.gate.state_entity) {
        parts.push(this._hass.states[this._config.gate.state_entity] && this._hass.states[this._config.gate.state_entity].state);
      }
      (this._config.status_bar || []).forEach((s) => {
        if (s.entity) parts.push(this._hass.states[s.entity] && this._hass.states[s.entity].state);
      });
      (this._config.top_bar_buttons || []).forEach((b) => {
        if (b.action === 'toggle' && b.entity) parts.push(this._hass.states[b.entity] && this._hass.states[b.entity].state);
      });
      (this._config.scenes || []).forEach((s) => {
        // Theo dõi state của TẤT CẢ entity trong scenes[].entity (có thể là 1
        // hoặc nhiều automation/scene/script) để card tự re-render khi trạng
        // thái đổi từ nơi khác — icon glow bám theo state thật của automation
        // (xem _isSceneActive).
        toArray(s.entity).forEach((e) => parts.push(this._hass.states[e] && this._hass.states[e].state));
      });
      // Robot: theo dõi cả state lẫn attribute vị trí của camera.entity (không
      // chỉ state, vì camera.entity thường đứng yên ở state "idle"/"recording"
      // trong khi attribute toạ độ mới là thứ đổi liên tục lúc robot di chuyển).
      // Thiếu 4 dòng dưới đây là lý do robot/trail trước đây chỉ "nhúc nhích"
      // khi tình cờ có entity khác (room/gate/status_bar) đổi state cùng lúc.
      if (this._config.robot && this._config.robot.entity) {
        const st = this._hass.states[this._config.robot.entity];
        const attrName = this._config.robot.position_attribute || 'robot_position';
        parts.push(st && st.state, st && JSON.stringify(st.attributes[attrName]));
      }
      if (this._config.robot && this._config.robot.vacuum_entity) {
        parts.push(this._hass.states[this._config.robot.vacuum_entity] && this._hass.states[this._config.robot.vacuum_entity].state);
      }
      if (this._config.robot && this._config.robot.status_entity) {
        parts.push(this._hass.states[this._config.robot.status_entity] && this._hass.states[this._config.robot.status_entity].state);
      }
      if (this._config.robot && this._config.robot.error_entity) {
        parts.push(this._hass.states[this._config.robot.error_entity] && this._hass.states[this._config.robot.error_entity].state);
      }
      return parts.join('|');
    } catch (err) {
      // Không để lỗi tính hash làm hỏng cả setter. Trả về giá trị đổi liên tục
      // để buộc thử render lại (và _render's try/catch sẽ log lỗi thật).
      // eslint-disable-next-line no-console
      console.error('[floorplan-card] Lỗi khi tính hash:', err);
      return `__hash_error__${Date.now()}`;
    }
  }
}

/* ------------------------- Templates (render) ------------------------- */

FloorplanCard.prototype._render = function _render() {
  if (!this.shadowRoot) return;
  const cfg = this._config;
  if (!cfg) return;
  // Cập nhật state trail TRƯỚC khi build template, để _robotTrailSvgTemplate()
  // bên dưới vẽ đúng dữ liệu (điểm mới + độ mờ) của lượt render này.
  this._updateRobotTrail();
  const rooms = (cfg.rooms || []).filter(roomHasContent);
  const linesRooms = rooms.filter((r) => r.label_position && r.anchor_position);
  const aspect = String(cfg.aspect_ratio || '16/9').replace(':', '/');
  // Cache 1 lần cho cả lượt render, để _roomTemplate không phải quét lại toàn
  // bộ rooms mỗi lần được gọi.
  this._roomTempRange = computeRoomTempRange(rooms, this._hass);

  // Cổng có thể ở 1 trong 2 chế độ: "cover" (1 entity cover duy nhất, biết
  // trạng thái mở/đóng) hoặc "switches" (3 switch độc lập mở/dừng/đóng, không
  // tự thân có trạng thái) -> đường neo chỉ cần ít nhất 1 entity điều khiển
  // được cấu hình ở đúng chế độ đang chọn, không nhất thiết phải là gate.entity.
  const gateHasControl = cfg.gate && (cfg.gate.control_mode === 'switches'
    ? (cfg.gate.open_entity || cfg.gate.close_entity || cfg.gate.stop_entity)
    : cfg.gate.entity);
  const gateLine = (gateHasControl && cfg.gate.position && cfg.gate.anchor_position)
    ? `<line data-x1-pct="${cfg.gate.position.x}" data-y1-pct="${cfg.gate.position.y}" data-x2-pct="${cfg.gate.anchor_position.x}" data-y2-pct="${cfg.gate.anchor_position.y}" class="anchor-line" vector-effect="non-scaling-stroke" />
       <circle data-cx-pct="${cfg.gate.anchor_position.x}" data-cy-pct="${cfg.gate.anchor_position.y}" r="3" class="anchor-dot" />`
    : '';

  const topBarLines = (cfg.top_bar_buttons || [])
    .filter((b) => b.position && b.anchor_position)
    .map((b) => `
      <line data-x1-pct="${b.position.x}" data-y1-pct="${b.position.y}" data-x2-pct="${b.anchor_position.x}" data-y2-pct="${b.anchor_position.y}" class="anchor-line" vector-effect="non-scaling-stroke" />
      <circle data-cx-pct="${b.anchor_position.x}" data-cy-pct="${b.anchor_position.y}" r="3" class="anchor-dot" />
    `).join('');

  this.shadowRoot.innerHTML = `
    <style>${STYLE}</style>
    <ha-card>
      <div class="wrapper" style="--fp-aspect:${aspect}">
        <img class="bg-image" src="${escapeHtml(cfg.background_image)}" alt="floorplan"
          onerror="this.style.display='none'; this.insertAdjacentHTML('afterend','&lt;div class=\'empty-state\' style=\'position:absolute;inset:0;display:flex;align-items:center;justify-content:center\'&gt;⚠️ Không tải được ảnh nền: '+this.getAttribute('src')+'&lt;/div&gt;')" />
        <svg class="overlay-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          ${linesRooms.map((r) => `
            <line data-x1-pct="${r.label_position.x}" data-y1-pct="${r.label_position.y}" data-x2-pct="${r.anchor_position.x}" data-y2-pct="${r.anchor_position.y}" class="anchor-line" vector-effect="non-scaling-stroke" />
            <circle data-cx-pct="${r.anchor_position.x}" data-cy-pct="${r.anchor_position.y}" r="3" class="anchor-dot" />
          `).join('')}
          ${gateLine}
          ${topBarLines}
          ${this._robotTrailSvgTemplate()}
        </svg>
        ${rooms.map((r) => this._roomTemplate(r)).join('')}
        ${this._gateTemplate()}
        ${this._robotTemplate()}
        ${this._topBarTemplate()}
        ${this._scenesTemplate()}
        ${this._statusBarTemplate()}
        ${this._contentPopupTemplate()}
        ${rooms.length === 0 ? '<div class="empty-state">Chưa cấu hình phòng nào (chưa có room nào gán temp_entity / humidity_entity / light_entities). Mở trình chỉnh sửa card để thêm.</div>' : ''}
      </div>
    </ha-card>
  `;

  if (!this._clickBound) {
    this.shadowRoot.addEventListener('click', (e) => this._handleClick(e));
    this._clickBound = true;
  }
  this._observeResize();
  this._bindGateSlide();
  requestAnimationFrame(() => this._updateSvgViewbox());
};

FloorplanCard.prototype._roomTemplate = function _roomTemplate(room) {
  const hass = this._hass;
  const lights = toArray(room.light_entities);
  const hasLights = lights.length > 0;
  const on = hasLights && anyOn(hass, lights);
  const dimmed = hasLights && lights.every((id) => isUnavailable(hass, id));
  // Đếm số đèn đang bật trên tổng số đèn đã khai báo cho phòng (light_entities)
  // để hiện "1/4" thay vì chỉ Bật/Tắt — tự tính lại mỗi lần render, không cần
  // khai báo thêm gì trong config.
  const onCount = lights.filter((id) => hass && hass.states && hass.states[id] && hass.states[id].state === 'on').length;
  const firstLight = lights[0] || '';
  const pos = room.label_position || { x: 10, y: 10 };
  const temp = room.temp_entity ? fmtNumber(hass, room.temp_entity, 1) : null;
  const hum = room.humidity_entity ? fmtNumber(hass, room.humidity_entity, 1) : null;

  // Viền/glow tag phòng đổi màu theo nhiệt độ tương đối trong dải min/max của
  // các phòng đang hiển thị (xem computeRoomTempRange). Nếu phòng không có
  // temp_entity, hoặc dải chưa đủ dữ liệu để so sánh (< 2 phòng có cảm biến,
  // hoặc các phòng gần như cùng nhiệt độ), giữ nguyên viền xanh mặc định.
  const rawTemp = (room.temp_entity && !isUnavailable(hass, room.temp_entity))
    ? parseFloat(hass.states[room.temp_entity].state) : NaN;
  const tempRange = this._roomTempRange;
  let roomTempStyle = '';
  let isHot = false;
  if (!Number.isNaN(rawTemp) && tempRange) {
    const ratio = (rawTemp - tempRange.min) / (tempRange.max - tempRange.min);
    const c = tempColorForRatio(ratio);
    roomTempStyle = `--room-border-color:rgba(${c.r},${c.g},${c.b},0.8); --room-glow-color:rgba(${c.r},${c.g},${c.b},0.45);`;
    isHot = rawTemp >= ROOM_HOT_THRESHOLD_C;
  }

  return `
    <div class="room-label ${isHot ? 'temp-hot' : ''}" style="left:${pos.x}%; top:${pos.y}%; ${roomTempStyle}">
      <div class="room-head">
        <ha-icon icon="${escapeHtml(room.icon || 'mdi:home-outline')}"></ha-icon>
        <div class="room-name" data-role="room-info" data-entity="${escapeHtml(firstLight)}">${escapeHtml(room.name)}</div>
      </div>
      <div class="room-meta">
        ${hasLights ? `
          <span class="chip toggle ${on ? 'on' : ''} ${dimmed ? 'dimmed' : ''}" data-role="room-toggle" data-room-id="${escapeHtml(room.id)}">
            <ha-icon icon="${on ? 'mdi:lightbulb' : 'mdi:lightbulb-outline'}"></ha-icon>
            <span>${dimmed ? '--' : (on ? `${onCount}/${lights.length}` : 'Tắt')}</span>
          </span>` : ''}
        ${room.temp_entity ? `<span class="chip metric"><ha-icon icon="mdi:thermometer"></ha-icon><span>${temp}°C</span></span>` : ''}
        ${room.humidity_entity ? `<span class="chip metric"><ha-icon icon="mdi:water-percent"></ha-icon><span>${hum}%</span></span>` : ''}
      </div>
    </div>
  `;
};

FloorplanCard.prototype._gateTemplate = function _gateTemplate() {
  const gate = this._config.gate;
  if (!gate || !gate.position) return '';
  if (gate.control_mode === 'switches') return this._gateButtonsTemplate();
  if (!gate.entity) return '';
  const unavailable = isUnavailable(this._hass, gate.entity);
  const state = !unavailable && this._hass.states[gate.entity].state;
  const isOpen = state === 'open';
  const statusText = unavailable ? '--' : (isOpen ? (gate.open_state_label || 'Đang mở') : (gate.closed_state_label || 'Đang khoá'));
  // Đóng -> mời vuốt để MỞ, mũi tên chỉ sang trái. Mở -> mời vuốt để ĐÓNG, mũi tên chỉ sang phải.
  const slideLabel = isOpen ? (gate.close_label || 'Vuốt để đóng') : (gate.open_label || 'Vuốt để mở');
  const chevronIcon = isOpen ? 'mdi:chevron-double-right' : 'mdi:chevron-double-left';
  const chevDir = isOpen ? '5px' : '-5px';
  const boxIcon = isOpen ? 'mdi:lock-open-variant' : 'mdi:lock';
  return `
    <div class="gate-widget" style="left:${gate.position.x}%; top:${gate.position.y}%;">
      <div class="gate-card">
        <div class="gate-head">
          <ha-icon icon="${boxIcon}"></ha-icon>
          <div>
            <div class="gate-title">${escapeHtml(gate.name || 'Cổng chính')}</div>
            <div class="gate-status">${escapeHtml(statusText)}</div>
          </div>
        </div>
        <div class="gate-slide-track" data-slide-mode="cover" data-entity="${escapeHtml(gate.entity)}" data-open="${isOpen ? '1' : '0'}" style="--chev-dir:${chevDir}">
          <div class="gate-slide-label">
            <ha-icon class="chev" icon="${chevronIcon}"></ha-icon>
            <span>${escapeHtml(slideLabel)}</span>
            <ha-icon class="chev" icon="${chevronIcon}"></ha-icon>
          </div>
          <div class="gate-slide-thumb" data-role="gate-slide-thumb" title="${escapeHtml(slideLabel)}">
            <ha-icon icon="${chevronIcon}"></ha-icon>
          </div>
        </div>
      </div>
    </div>
  `;
};

// Chế độ 3 switch độc lập (dùng khi cổng không có 1 entity cover "biết trạng
// thái" duy nhất, mà chỉ có switch bấm-là-chạy — ví dụ ESP kích trực tiếp vào
// chân OP/CL/STP của board điều khiển cổng, y hệt 1 lần bấm nút vật lý).
// MỞ/ĐÓNG vẫn bắt buộc VUỐT (giống hệt chế độ cover) để tránh chạm nhầm gây
// cổng tự chạy — đây là hành động có rủi ro an ninh. DỪNG thì giữ nút bấm tap
// bình thường: dừng không có rủi ro "chạm nhầm gây hại" như mở/đóng, và cần
// phản hồi ngay lập tức khi khẩn cấp, không nên bắt người dùng phải vuốt đúng
// thao tác trong lúc gấp.
//
// Vì switch là lệnh tức thời (pulse), bản thân nó không mang trạng thái "đang
// mở hay đóng" -> KHÔNG suy đoán trạng thái từ switch:
//  - Nếu có khai báo gate.state_entity (vd binary_sensor từ công tắc hành
//    trình): track vuốt hoạt động giống hệt chế độ cover — chỉ cho vuốt theo
//    1 chiều còn lại tương ứng trạng thái hiện tại.
//  - Nếu KHÔNG khai báo: track trung tính, thumb bắt đầu ở giữa, vuốt trái để
//    mở / vuốt phải để đóng, buông giữa chừng (chưa đủ xa) tự trượt lại giữa.
FloorplanCard.prototype._gateButtonsTemplate = function _gateButtonsTemplate() {
  const gate = this._config.gate;
  if (!gate.open_entity && !gate.close_entity && !gate.stop_entity) return '';
  const hasState = !!gate.state_entity;
  const unavailable = hasState && isUnavailable(this._hass, gate.state_entity);
  const state = hasState && !unavailable && this._hass.states[gate.state_entity].state;
  const isOpen = state === 'on' || state === 'open';
  const statusText = !hasState ? '' : (unavailable ? '--' : (isOpen ? (gate.open_state_label || 'Đang mở') : (gate.closed_state_label || 'Đang khoá')));
  const boxIcon = hasState ? (isOpen ? 'mdi:lock-open-variant' : 'mdi:lock') : 'mdi:gate';
  const openLabel = gate.open_label || 'Mở';
  const closeLabel = gate.close_label || 'Đóng';

  let control = '';
  if (gate.open_entity && gate.close_entity) {
    if (hasState) {
      const slideLabel = isOpen ? `Vuốt để ${closeLabel.toLowerCase()}` : `Vuốt để ${openLabel.toLowerCase()}`;
      const chevronIcon = isOpen ? 'mdi:chevron-double-right' : 'mdi:chevron-double-left';
      const chevDir = isOpen ? '5px' : '-5px';
      control = `
        <div class="gate-slide-track" data-slide-mode="switch-directional" data-open-entity="${escapeHtml(gate.open_entity)}" data-close-entity="${escapeHtml(gate.close_entity)}" data-open="${isOpen ? '1' : '0'}" style="--chev-dir:${chevDir}">
          <div class="gate-slide-label">
            <ha-icon class="chev" icon="${chevronIcon}"></ha-icon>
            <span>${escapeHtml(slideLabel)}</span>
            <ha-icon class="chev" icon="${chevronIcon}"></ha-icon>
          </div>
          <div class="gate-slide-thumb" data-role="gate-slide-thumb" title="${escapeHtml(slideLabel)}">
            <ha-icon icon="${chevronIcon}"></ha-icon>
          </div>
        </div>`;
    } else {
      control = `
        <div class="gate-slide-track neutral" data-slide-mode="switch-neutral" data-open-entity="${escapeHtml(gate.open_entity)}" data-close-entity="${escapeHtml(gate.close_entity)}">
          <div class="gate-slide-label">
            <span class="side">
              <ha-icon class="chev" icon="mdi:chevron-double-left"></ha-icon>
              <span>${escapeHtml(openLabel)}</span>
            </span>
            <span class="side">
              <span>${escapeHtml(closeLabel)}</span>
              <ha-icon class="chev" icon="mdi:chevron-double-right"></ha-icon>
            </span>
          </div>
          <div class="gate-slide-thumb" data-role="gate-slide-thumb" title="Vuốt trái để ${escapeHtml(openLabel.toLowerCase())}, vuốt phải để ${escapeHtml(closeLabel.toLowerCase())}">
            <ha-icon icon="mdi:unfold-more-horizontal"></ha-icon>
          </div>
        </div>`;
    }
  } else {
    // Thiếu 1 trong 2 chiều -> không đủ để làm track vuốt có ý nghĩa (không
    // có "chiều đối lập" để so sánh) -> fallback về nút bấm cho chiều đang có.
    const tapBtn = (entity, icon, label) => (entity
      ? `<button class="gate-btn" data-role="gate-btn" data-gate-entity="${escapeHtml(entity)}" title="${escapeHtml(label)}">
           <ha-icon icon="${icon}"></ha-icon><span>${escapeHtml(label)}</span>
         </button>`
      : '');
    control = `<div class="gate-btn-row">${tapBtn(gate.open_entity, 'mdi:arrow-left-bold', openLabel)}${tapBtn(gate.close_entity, 'mdi:arrow-right-bold', closeLabel)}</div>`;
  }

  // Nút Dừng mặc định hiện nếu có khai báo stop_entity; có thể tắt hẳn qua
  // gate.show_stop_button: false (ví dụ khi bạn thấy không cần thiết, đỡ
  // rối giao diện). Đặt nhỏ, dạng tròn, cạnh track thay vì chiếm 1 hàng riêng.
  const showStop = gate.stop_entity && gate.show_stop_button !== false;
  const stopMini = showStop
    ? `<button class="gate-stop-mini" data-role="gate-btn" data-gate-entity="${escapeHtml(gate.stop_entity)}" title="Dừng">
         <ha-icon icon="mdi:stop"></ha-icon>
       </button>`
    : '';

  return `
    <div class="gate-widget" style="left:${gate.position.x}%; top:${gate.position.y}%;">
      <div class="gate-card">
        <div class="gate-head">
          <ha-icon icon="${boxIcon}"></ha-icon>
          <div>
            <div class="gate-title">${escapeHtml(gate.name || 'Cổng chính')}</div>
            ${statusText ? `<div class="gate-status">${escapeHtml(statusText)}</div>` : ''}
          </div>
        </div>
        <div class="gate-control-row">
          ${control}
          ${stopMini}
        </div>
      </div>
    </div>
  `;
};

/* --------------------------- Robot hút bụi (realtime) --------------------------- */
// Robot tự vẽ bản đồ nội bộ theo hệ toạ độ riêng của nó (thường tính bằng mm,
// gốc toạ độ tuỳ hãng) — hoàn toàn khác với hệ % của ảnh floorplan do người
// dùng tự chụp/tự vẽ.
//
// Có 2 đường tính, chọn theo số điểm hiệu chỉnh hợp lệ đang có:
//  - >= 4 điểm: dùng HOMOGRAPHY (phép biến đổi phối cảnh) + hiệu chỉnh cục bộ
//    theo trọng số nghịch đảo khoảng cách (IDW) tới các điểm gần nhất. Đây là
//    đường được khuyến nghị — xử lý được cả xoay/nghiêng của ảnh phối cảnh
//    (isometric, 3D render...), và càng thêm điểm rải khắp các phòng thì càng
//    chính xác cục bộ ở từng khu vực, không chỉ đúng ở 2 điểm hiệu chỉnh gốc.
//  - Đúng 2 điểm (config cũ, chưa nâng cấp): dùng scale tuyến tính độc lập
//    theo trục X/Y như bản gốc, GIỮ LẠI để không phá config có sẵn của người
//    dùng cũ — nhưng đường này không bù được xoay/nghiêng nên sai số sẽ tăng
//    dần theo khoảng cách tới 2 điểm hiệu chỉnh.
//  - < 2 điểm: chưa đủ dữ liệu, không hiển thị robot.
FloorplanCard.prototype._robotPosition = function _robotPosition() {
  const r = this._config.robot;
  if (!r || !r.entity || !this._hass || !this._hass.states[r.entity]) return null;
  const attrName = r.position_attribute || 'robot_position';
  const raw = this._hass.states[r.entity].attributes[attrName];
  return this._robotPositionFromRaw(raw);
};

// Quy đổi 1 giá trị attribute vị trí THÔ (dạng [x,y] hoặc {x,y}, đơn vị riêng
// của robot) sang % trên ảnh floorplan — tách riêng khỏi _robotPosition() để
// dùng lại được cho cả vị trí LIVE (đọc trực tiếp từ this._hass.states) lẫn
// vị trí LỊCH SỬ (đọc từ HA History API khi khôi phục trail sau reload/đổi
// thiết bị — xem _hydrateRobotTrailFromHistory), tránh lặp lại toàn bộ logic
// hiệu chỉnh/homography ở 2 nơi.
FloorplanCard.prototype._robotPositionFromRaw = function _robotPositionFromRaw(raw) {
  const r = this._config.robot;
  if (!r) return null;
  const cal = (r.calibration || []).filter((c) => c && c.robot && c.image
    && Number.isFinite(Number(c.robot.x)) && Number.isFinite(Number(c.robot.y))
    && Number.isFinite(Number(c.image.x)) && Number.isFinite(Number(c.image.y)));
  if (cal.length < 2) return null;
  if (raw === undefined || raw === null) return null;
  let rx;
  let ry;
  if (Array.isArray(raw)) { [rx, ry] = raw; } else if (typeof raw === 'object') { rx = raw.x; ry = raw.y; } else return null;
  rx = Number(rx); ry = Number(ry);
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;

  // Đảo trục nếu bản đồ robot bị xoay 90° so với ảnh của người dùng. Với
  // homography, xoay góc bất kỳ đã được bù trong ma trận -> swap_xy chỉ còn
  // cần thiết cho đường 2-điểm cũ, nhưng áp dụng luôn ở đây cho nhất quán
  // (không ảnh hưởng gì nếu tắt).
  const swap = (p) => (r.swap_xy ? { x: p.y, y: p.x } : p);
  const qp = swap({ x: rx, y: ry });

  const pos = cal.length >= 4
    ? this._robotPositionHomography(cal, qp, swap)
    : this._robotPositionLegacyTwoPoint(cal, qp, swap);
  if (!pos) return null;
  return { x: Math.min(100, Math.max(0, pos.x)), y: Math.min(100, Math.max(0, pos.y)) };
};

// Đường cũ: scale tuyến tính độc lập theo trục X/Y từ đúng 2 điểm. Chỉ dùng
// khi config chưa được nâng cấp lên >=4 điểm (xem _robotPosition ở trên).
FloorplanCard.prototype._robotPositionLegacyTwoPoint = function _robotPositionLegacyTwoPoint(cal, qp, swap) {
  const [c1, c2] = cal;
  const p1 = swap({ x: Number(c1.robot.x), y: Number(c1.robot.y) });
  const p2 = swap({ x: Number(c2.robot.x), y: Number(c2.robot.y) });

  const dxRobot = p2.x - p1.x;
  const dyRobot = p2.y - p1.y;
  if (dxRobot === 0 || dyRobot === 0) return null; // 2 điểm hiệu chỉnh trùng trục -> không đủ để nội suy

  const scaleX = (c2.image.x - c1.image.x) / dxRobot;
  const scaleY = (c2.image.y - c1.image.y) / dyRobot;
  return {
    x: c1.image.x + (qp.x - p1.x) * scaleX,
    y: c1.image.y + (qp.y - p1.y) * scaleY,
  };
};

// Đường mới (khuyến nghị, >=4 điểm): homography toàn cục + hiệu chỉnh cục bộ
// theo IDW (trọng số nghịch đảo bình phương khoảng cách) từ residual (sai số
// thực đo) tại các điểm hiệu chỉnh GẦN robot hiện tại nhất, trong không gian
// toạ độ robot. Nhờ vậy vị trí robot khi đứng đúng tại 1 điểm đã hiệu chỉnh
// sẽ khớp gần như tuyệt đối với vị trí đã kéo trên ảnh, còn ở giữa các điểm
// thì nội suy mượt -> tương đương "hiệu chỉnh riêng từng khu vực" mà không
// cần chia phòng tường minh, chỉ cần rải đủ điểm hiệu chỉnh vào các phòng.
FloorplanCard.prototype._robotPositionHomography = function _robotPositionHomography(cal, qp, swap) {
  const pts = cal.map((c) => {
    const rp = swap({ x: Number(c.robot.x), y: Number(c.robot.y) });
    return { rx: rp.x, ry: rp.y, ix: Number(c.image.x), iy: Number(c.image.y) };
  });

  // Cache theo "chữ ký" bộ điểm hiệu chỉnh để không giải lại hệ 8 ẩn mỗi lần
  // hass cập nhật (thường vài giây/lần) -> chỉ giải lại khi người dùng thực
  // sự sửa điểm hiệu chỉnh trong trình chỉnh sửa card.
  const sig = JSON.stringify(pts);
  if (!this._homographyCache || this._homographyCache.sig !== sig) {
    const H = computeHomography(pts);
    let residuals = null;
    if (H) {
      residuals = pts.map((p) => {
        const pred = applyHomography(H, p.rx, p.ry);
        return pred ? { rx: p.rx, ry: p.ry, dx: p.ix - pred.x, dy: p.iy - pred.y } : null;
      }).filter(Boolean);
    }
    this._homographyCache = { sig, H, residuals };
  }
  const { H, residuals } = this._homographyCache;
  if (!H) return null; // các điểm hiệu chỉnh gần như thẳng hàng/trùng nhau -> không giải được, cần thêm điểm lệch nhau hơn

  const predQ = applyHomography(H, qp.x, qp.y);
  if (!predQ) return null;

  let wSum = 0;
  let dxSum = 0;
  let dySum = 0;
  residuals.forEach((res) => {
    const dist2 = (qp.x - res.rx) ** 2 + (qp.y - res.ry) ** 2;
    const w = 1 / (dist2 + 1e-6); // +epsilon để không chia cho 0 khi robot đứng đúng tại 1 điểm hiệu chỉnh
    wSum += w; dxSum += w * res.dx; dySum += w * res.dy;
  });
  const corrX = wSum > 0 ? dxSum / wSum : 0;
  const corrY = wSum > 0 ? dySum / wSum : 0;
  return { x: predQ.x + corrX, y: predQ.y + corrY };
};

// Ánh xạ trạng thái robot (state chuẩn của HA hoặc chuỗi trạng thái chi tiết hơn
// từ integration, ví dụ "Sleeping", "Cleaning", "Charging completed"...) sang 1
// bong bóng cảm xúc vui nhộn. Trả về null nếu trạng thái bình thường, không cần
// làm phiền người xem bằng bong bóng (ví dụ đang sạc xong, đứng yên).
FloorplanCard.prototype._robotStatusBubble = function _robotStatusBubble(rawStatus, errorText) {
  const s = String(rawStatus || '').toLowerCase();
  if (!s) return null;
  if (s.includes('unavailable') || s.includes('offline') || s.includes('disconnect')) {
    return { mood: 'offline', emoji: '📴', text: 'Mất kết nối' };
  }
  if (s.includes('error') || s.includes('fault') || s.includes('stuck') || s.includes('trapped')) {
    return { mood: 'error', emoji: '😵', text: (errorText && String(errorText).toLowerCase() !== 'no error') ? errorText : 'Gặp sự cố' };
  }
  if (s.includes('sleep')) return { mood: 'sleep', emoji: '😴', text: 'z z z' };
  if (s.includes('mop')) return { mood: 'mop', emoji: '💧', text: 'Đang lau nhà' };
  if (s.includes('clean') && !s.includes('completed')) return { mood: 'clean', emoji: '🧹', text: 'Đang dọn dẹp' };
  if (s.includes('return')) return { mood: 'return', emoji: '🔌', text: 'Đang về sạc' };
  if (s.includes('pause')) return { mood: 'pause', emoji: '⏸️', text: 'Tạm dừng' };
  if (s.includes('full') || s.includes('bin')) return { mood: 'full', emoji: '🗑️', text: 'Đầy hộp rác' };
  if (s.includes('charging') && s.includes('complet')) return { mood: 'charged', emoji: '🔋', text: 'Đã sạc đầy' };
  if (s.includes('charging')) return { mood: 'charge', emoji: '🔋', text: 'Đang sạc' };
  if (s.includes('standby')) return { mood: 'standby', emoji: '🌙', text: 'Standby' };
  if (s.includes('idle') || s.includes('docked')) return { mood: 'idle-wait', emoji: '🙂', text: 'Đang chờ' };
  return null;
};

/* --------------------------- Robot: vệt đường đi (trail) --------------------------- */
// Ghi lại các điểm robot đã đi qua trong lúc "cleaning" thành 1 mảng
// {x, y, t} (% trên ảnh + timestamp), vẽ thành 1 polyline mờ dần sau khi
// robot.vacuum_entity báo hoàn tất (chuyển sang docked/idle). Toàn bộ state
// (mảng điểm, mốc hoàn tất, timer đếm mờ) sống trên chính instance của card
// (this._robotTrail*) — không lưu vào config, vì đây là dữ liệu runtime chứ
// không phải cấu hình người dùng khai báo.

// Lấy số phút "mờ dần" đã cấu hình, có fallback an toàn khi field trống/rỗng
// (input number để trống -> rawValue là chuỗi rỗng '' khi qua _onFieldChange).
FloorplanCard.prototype._robotTrailFadeMinutes = function _robotTrailFadeMinutes() {
  const raw = this._config.robot && this._config.robot.trail && this._config.robot.trail.fade_after_minutes;
  if (raw === undefined || raw === null || raw === '') return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
};

FloorplanCard.prototype._updateRobotTrail = function _updateRobotTrail() {
  const cfg = this._config.robot;
  const trailOn = !!(cfg && cfg.trail && cfg.trail.enabled && cfg.vacuum_entity && this._hass);

  // Xoá sạch vệt khi SANG NGÀY MỚI (yêu cầu: không giữ vệt qua ngày) — kiểm
  // tra TRƯỚC mọi logic khác, không phụ thuộc trailOn, để dọn dẹp đúng dù
  // trail vừa được bật lại sau khi tắt lúc nửa đêm. Đồng thời day-key này còn
  // là ranh giới cho việc khôi phục từ History API (chỉ query trong ngày).
  const now0 = new Date();
  const todayKey = `${now0.getFullYear()}-${now0.getMonth()}-${now0.getDate()}`;
  if (this._robotTrailDay && this._robotTrailDay !== todayKey) {
    this._robotTrailPoints = [];
    this._robotTrailCompletedAt = null;
    this._stopRobotTrailFadeTimer();
  }
  this._robotTrailDay = todayKey;

  if (!trailOn) {
    // Trail tắt (hoặc thiếu vacuum_entity để biết trạng thái) -> đảm bảo không
    // giữ rác trong bộ nhớ từ lần trước lỡ đã bật rồi tắt lại.
    if (this._robotTrailPoints.length || this._robotTrailCompletedAt !== null) {
      this._robotTrailPoints = [];
      this._robotTrailCompletedAt = null;
    }
    this._robotTrailPrevVacuumState = null;
    this._stopRobotTrailFadeTimer();
    return;
  }

  const st = this._hass.states[cfg.vacuum_entity];
  const current = st && st.state;
  const prev = this._robotTrailPrevVacuumState;

  if (current === 'cleaning' && prev !== 'cleaning' && prev !== 'paused') {
    if (prev === null) {
      // prev === null nghĩa là ĐÂY LÀ LẦN ĐẦU card này quan sát state (vừa
      // connect/reload/mở trên thiết bị khác) — KHÔNG PHẢI robot vừa thật sự
      // bắt đầu dọn. Trước đây code coi luôn đây là "phiên mới" và xoá
      // trắng -> chính là lý do trail luôn mất khi reload dù robot vẫn đang
      // dọn dở. Giờ thử khôi phục lại vệt đã đi từ HA History API thay vì
      // xoá trắng; nếu khôi phục thất bại/không có gì, trail vẫn tự xây dựng
      // tiếp bình thường từ đây theo nhánh live bên dưới.
      this._hydrateRobotTrailFromHistory(current);
    } else {
      // Chuyển sang dọn dẹp từ 1 trạng thái "nghỉ" thật sự (không phải resume
      // sau paused) -> coi là phiên mới, xoá vệt cũ, bắt đầu ghi lại từ đầu.
      this._robotTrailPoints = [];
      this._robotTrailCompletedAt = null;
      this._stopRobotTrailFadeTimer();
    }
  } else if ((prev === 'cleaning' || prev === 'returning') && (current === 'docked' || current === 'idle')
    && this._robotTrailPoints.length && this._robotTrailCompletedAt === null) {
    // Vừa hoàn tất -> đóng băng số điểm hiện tại, bắt đầu đếm ngược mờ dần.
    this._robotTrailCompletedAt = Date.now();
    this._startRobotTrailFadeTimer();
  } else if (prev === null && (current === 'docked' || current === 'idle')) {
    // Card vừa mở đúng lúc robot vừa dọn xong gần đây (không rõ đã bao lâu)
    // -> thử khôi phục lại vệt của phiên gần nhất để tiếp tục hiệu ứng mờ
    // dần đúng chỗ thay vì im lặng không hiện gì.
    this._hydrateRobotTrailFromHistory(current);
  }
  this._robotTrailPrevVacuumState = current;

  if (current === 'cleaning' && this._robotTrailCompletedAt === null) {
    const pos = this._robotPosition();
    if (pos) {
      const last = this._robotTrailPoints[this._robotTrailPoints.length - 1];
      const dist = last ? Math.hypot(pos.x - last.x, pos.y - last.y) : 0;
      // Throttle: chỉ thêm điểm mới nếu đã di chuyển đủ xa (>=0.3% ảnh) HOẶC đã
      // đủ lâu (>=5s) kể từ điểm trước -> vệt vẫn mượt mà không phình dữ liệu
      // với card cập nhật vị trí liên tục mỗi vài giây.
      const movedEnough = !last || dist >= 0.3;
      const longEnough = !last || (Date.now() - last.t) >= 5000;
      if (movedEnough || longEnough) {
        // Chống glitch toạ độ: nếu bước nhảy so với điểm trước lớn bất thường
        // (tích hợp robot đôi khi trả về vị trí sai/mặc định trong 1 nhịp đọc
        // rồi tự sửa lại ngay sau đó — ví dụ lúc robot re-sync bản đồ, đổi
        // segment, hoặc rớt kết nối tạm thời), KHÔNG vẽ đường nối từ điểm
        // trước sang điểm này (breakBefore) thay vì cố đoán và loại bỏ điểm.
        // Vẫn giữ lại điểm (phòng khi đó là di chuyển thật), nhưng nó trở
        // thành khởi đầu 1 đoạn (segment) mới trong _robotTrailSvgTemplate();
        // nếu đúng là glitch cô lập, nó sẽ không có gì nối vào -> tự vô hình.
        const ROBOT_TRAIL_MAX_JUMP_PCT = 15; // % đường chéo ảnh cho 1 bước throttle
        this._robotTrailPoints.push({
          x: pos.x,
          y: pos.y,
          t: Date.now(),
          breakBefore: last ? dist > ROBOT_TRAIL_MAX_JUMP_PCT : false,
        });
        // Chặn an toàn: nếu vì lý do gì đó (lỗi tích hợp, sensor đứng ở
        // "cleaning" không đổi) phiên kéo dài bất thường, tránh phình bộ nhớ.
        const MAX_POINTS = 3000;
        if (this._robotTrailPoints.length > MAX_POINTS) this._robotTrailPoints.shift();
      }
    }
  }

  if (this._robotTrailCompletedAt !== null) {
    const fadeMs = this._robotTrailFadeMinutes() * 60000;
    if (Date.now() - this._robotTrailCompletedAt >= fadeMs) {
      this._robotTrailPoints = [];
      this._robotTrailCompletedAt = null;
      this._stopRobotTrailFadeTimer();
    }
  }
};

// Khôi phục vệt đường đi từ HA History API khi card không rõ trạng thái
// trước đó (vừa reload / mở trên thiết bị khác) mà robot đang dọn hoặc vừa
// dọn xong gần đây — thay vì bắt đầu lại từ con số 0. CHỈ query trong phạm
// vi TỪ ĐẦU NGÀY HÔM NAY tới hiện tại: vừa đủ để tìm đúng phiên đang chạy dở
// (không cần biết nó bắt đầu chính xác lúc nào), vừa khớp yêu cầu "xoá vệt
// khi hết ngày" (không bao giờ vô tình kéo vệt của hôm qua), vừa tránh
// query lịch sử nhiều ngày gây nặng không cần thiết.
// `current`: state hiện tại của vacuum_entity tại thời điểm gọi (truyền vào
// từ _updateRobotTrail để set lại _robotTrailPrevVacuumState cho đúng sau
// khi xong, tránh bị hiểu nhầm là "chưa từng quan sát" ở lượt kế tiếp).
FloorplanCard.prototype._hydrateRobotTrailFromHistory = async function _hydrateRobotTrailFromHistory(current) {
  const cfg = this._config.robot;
  if (!cfg || !cfg.vacuum_entity || !cfg.entity || !this._hass || !this._hass.callApi) return;
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const ids = [cfg.vacuum_entity, cfg.entity];
    const path = `history/period/${startOfDay.toISOString()}`
      + `?filter_entity_id=${ids.map(encodeURIComponent).join(',')}`
      + `&end_time=${encodeURIComponent(now.toISOString())}`
      + '&minimal_response=0&significant_changes_only=0';
    const result = await this._hass.callApi('GET', path);
    if (!Array.isArray(result) || !result.length) return;
    // Kết quả trả về 1 mảng con cho mỗi entity đã yêu cầu, nhưng để chắc ăn
    // (không phụ thuộc đúng thứ tự) thì tự nhận diện qua entity_id của dòng
    // đầu tiên trong mỗi mảng con thay vì giả định vị trí index cố định.
    const vacuumRows = result.find((rows) => rows && rows[0] && rows[0].entity_id === cfg.vacuum_entity) || [];
    const posRows = result.find((rows) => rows && rows[0] && rows[0].entity_id === cfg.entity) || [];
    if (!vacuumRows.length || !posRows.length) return;

    // Đi qua lịch sử state của vacuum_entity trong ngày để tìm mốc BẮT ĐẦU
    // của phiên "cleaning" GẦN NHẤT — dùng đúng điều kiện chuyển trạng thái
    // như nhánh live ở _updateRobotTrail, để 2 đường luôn nhất quán nhau.
    let sessionStartMs = null;
    let sessionEndMs = null; // còn null nghĩa là vẫn đang dọn tới hiện tại
    let prevState = null;
    vacuumRows.forEach((row) => {
      const t = new Date(row.last_changed).getTime();
      if (row.state === 'cleaning' && prevState !== 'cleaning' && prevState !== 'paused') {
        sessionStartMs = t;
        sessionEndMs = null;
      } else if (sessionStartMs !== null && (prevState === 'cleaning' || prevState === 'returning')
        && (row.state === 'docked' || row.state === 'idle') && sessionEndMs === null) {
        sessionEndMs = t;
      }
      prevState = row.state;
    });
    if (sessionStartMs === null) return; // hôm nay chưa ghi nhận phiên dọn nào -> không có gì để khôi phục

    // Phiên đã kết thúc từ lâu hơn thời gian mờ dần đã cấu hình -> coi như
    // hết hạn hiển thị (khớp hành vi live: trail tự xoá hẳn sau khi mờ hết).
    if (sessionEndMs !== null) {
      const fadeMs = this._robotTrailFadeMinutes() * 60000;
      if (Date.now() - sessionEndMs >= fadeMs) return;
    }

    const attrName = cfg.position_attribute || 'robot_position';
    const points = [];
    let last = null;
    posRows.forEach((row) => {
      const t = new Date(row.last_updated || row.last_changed).getTime();
      if (t < sessionStartMs) return;
      if (sessionEndMs !== null && t > sessionEndMs) return;
      const raw = row.attributes && row.attributes[attrName];
      const pct = this._robotPositionFromRaw(raw);
      if (!pct) return;
      const dist = last ? Math.hypot(pct.x - last.x, pct.y - last.y) : 0;
      points.push({ x: pct.x, y: pct.y, t, breakBefore: last ? dist > 15 : false });
      last = pct;
    });
    if (points.length < 2) return; // không đủ điểm để vẽ được gì -> giữ nguyên trạng thái rỗng, để live tự xây tiếp

    this._robotTrailPoints = points.slice(-3000);
    this._robotTrailCompletedAt = sessionEndMs;
    if (sessionEndMs !== null) this._startRobotTrailFadeTimer();
    this._safeRender();
  } catch (err) {
    // Lỗi mạng/API (vd offline lúc mở app, hoặc HA chưa kịp sẵn sàng) -> im
    // lặng bỏ qua, không chặn card; trail vẫn hoạt động bình thường theo
    // cách theo dõi trực tiếp (live) như trước khi có tính năng khôi phục.
  } finally {
    // Dù thành công hay thất bại, đánh dấu đã "biết" trạng thái hiện tại để
    // các lượt _updateRobotTrail kế tiếp không hiểu nhầm là "chưa từng quan
    // sát" (prev === null) và thử khôi phục lặp lại liên tục mỗi lần hass
    // cập nhật.
    this._robotTrailPrevVacuumState = current;
  }
};

// Độ mờ hiện tại của trail: 1 = còn nguyên (đang dọn hoặc vừa xong),
// giảm tuyến tính về 0 trong suốt N phút kể từ lúc hoàn tất.
FloorplanCard.prototype._robotTrailOpacity = function _robotTrailOpacity() {
  if (this._robotTrailCompletedAt === null) return 1;
  const fadeMs = Math.max(1, this._robotTrailFadeMinutes() * 60000);
  const elapsed = Date.now() - this._robotTrailCompletedAt;
  return Math.min(1, Math.max(0, 1 - elapsed / fadeMs));
};

// setInterval riêng CHỈ chạy trong lúc đang đếm mờ dần: attribute vị trí của
// camera.entity thường đứng yên sau khi robot về sạc, nên sẽ không có gì kích
// hoạt set hass() -> nếu không có timer này, trail sẽ đứng hình rồi biến mất
// đột ngột ở lần hass update tình cờ kế tiếp thay vì mờ dần mượt như đã chốt.
FloorplanCard.prototype._startRobotTrailFadeTimer = function _startRobotTrailFadeTimer() {
  if (this._robotTrailFadeTimer) return;
  this._robotTrailFadeTimer = setInterval(() => this._safeRender(), 7000);
};

FloorplanCard.prototype._stopRobotTrailFadeTimer = function _stopRobotTrailFadeTimer() {
  if (this._robotTrailFadeTimer) {
    clearInterval(this._robotTrailFadeTimer);
    this._robotTrailFadeTimer = null;
  }
};

FloorplanCard.prototype._robotTrailSvgTemplate = function _robotTrailSvgTemplate() {
  const cfg = this._config.robot;
  if (!cfg || !cfg.trail || !cfg.trail.enabled) return '';
  if (this._robotTrailPoints.length < 2) return '';
  const opacity = this._robotTrailOpacity();
  if (opacity <= 0) return '';
  // Tách mảng điểm phẳng thành nhiều đoạn (segment) tại mỗi chỗ breakBefore =
  // true (bước nhảy toạ độ bất thường, xem _updateRobotTrail) — mỗi đoạn vẽ
  // 1 <polyline> riêng, không nối giữa các đoạn. Đoạn chỉ có 1 điểm (glitch
  // cô lập, không có điểm liền kề hợp lệ) tự động bị bỏ qua vì <polyline>
  // cần >=2 điểm mới hiện ra gì đó trên màn hình.
  const segments = [[]];
  this._robotTrailPoints.forEach((p) => {
    if (p.breakBefore) segments.push([]);
    segments[segments.length - 1].push(p);
  });
  return segments
    .filter((seg) => seg.length >= 2)
    .map((seg) => {
      const pointsPct = seg.map((p) => `${p.x},${p.y}`).join(' ');
      return `<polyline data-points-pct="${escapeHtml(pointsPct)}" class="robot-trail" style="opacity:${opacity}" vector-effect="non-scaling-stroke" />`;
    })
    .join('');
};

FloorplanCard.prototype._robotTemplate = function _robotTemplate() {
  const r = this._config.robot;
  if (!r || !r.entity) return '';
  const pos = this._robotPosition();
  if (!pos) return '';
  const infoEntity = r.vacuum_entity || r.entity;
  const stateEntity = r.vacuum_entity && this._hass.states[r.vacuum_entity] ? r.vacuum_entity : r.entity;
  const state = this._hass.states[stateEntity] ? this._hass.states[stateEntity].state : '';
  const cleaning = state === 'cleaning';

  // Trạng thái chi tiết (nếu có cấu hình status_entity riêng, ví dụ sensor "Status"
  // của Dreame có chuỗi rõ nghĩa hơn như "Sleeping"/"Charging completed") -> ưu
  // tiên dùng nó để chọn bong bóng cảm xúc; không có thì dùng state chuẩn của
  // entity vacuum.
  const statusEntity = r.status_entity && this._hass.states[r.status_entity] ? r.status_entity : stateEntity;
  const rawStatus = this._hass.states[statusEntity] ? this._hass.states[statusEntity].state : state;
  let errorText = '';
  if (r.error_entity && this._hass.states[r.error_entity]) {
    errorText = this._hass.states[r.error_entity].state;
  } else if (this._hass.states[stateEntity] && this._hass.states[stateEntity].attributes && this._hass.states[stateEntity].attributes.error) {
    errorText = this._hass.states[stateEntity].attributes.error;
  }
  const bubble = this._robotStatusBubble(rawStatus, errorText);

  return `
    <div class="robot-marker ${cleaning ? 'active' : ''}" data-role="robot-info" data-entity="${escapeHtml(infoEntity)}"
      style="left:${pos.x}%; top:${pos.y}%;" title="Robot hút bụi (${escapeHtml(state || '--')})">
      <div class="robot-pulse"></div>
      ${bubble ? `
        <div class="robot-bubble mood-${bubble.mood}">
          <span class="robot-bubble-emoji">${bubble.emoji}</span><span>${escapeHtml(bubble.text)}</span>
          ${bubble.mood === 'clean' ? '<span class="dust-mote d1"></span><span class="dust-mote d2"></span><span class="dust-mote d3"></span>' : ''}
        </div>` : ''}
      <div class="robot-tag">Robot hút bụi</div>
      <ha-icon icon="${escapeHtml(r.icon || 'mdi:robot-vacuum')}"></ha-icon>
    </div>
  `;
};

FloorplanCard.prototype._topBarTemplate = function _topBarTemplate() {
  const buttons = this._config.top_bar_buttons || [];
  if (!buttons.length) return '';
  const stacked = [];
  const free = [];
  buttons.forEach((b, i) => (b.position ? free.push([b, i]) : stacked.push([b, i])));

  const btnHtml = (b, i) => `
    <ha-icon icon="${escapeHtml(b.icon || 'mdi:help-circle')}"></ha-icon><span>${escapeHtml(b.label || '')}</span>`;

  const stackedHtml = stacked.length
    ? `<div class="top-bar">${stacked.map(([b, i]) => `
      <div class="top-btn" data-role="topbar-btn" data-index="${i}">${btnHtml(b, i)}</div>`).join('')}</div>`
    : '';

  // Nút đã được kéo tới vị trí riêng (b.position) đặt trực tiếp trong khung ảnh
  // theo tọa độ %, độc lập với nhóm mặc định ở góc trên-phải.
  const freeHtml = free.map(([b, i]) => `
    <div class="top-btn top-btn--free" data-role="topbar-btn" data-index="${i}"
      style="left:${b.position.x}%; top:${b.position.y}%;">${btnHtml(b, i)}</div>`).join('');

  return stackedHtml + freeHtml;
};

FloorplanCard.prototype._scenesTemplate = function _scenesTemplate() {
  const scenes = this._config.scenes || [];
  if (!scenes.length) return '';
  return `
    <div class="scenes-panel">
      <div class="scenes-title">Kịch bản nhanh</div>
      <div class="scenes-grid">
        ${scenes.map((s, i) => `
          <button class="scene-btn${this._isSceneActive(s, i) ? ' scene-btn--active' : ''}" data-role="scene-btn" data-index="${i}">
            <ha-icon icon="${escapeHtml(s.icon || 'mdi:play')}"></ha-icon><span>${escapeHtml(s.label || '')}</span>
          </button>`).join('')}
      </div>
    </div>`;
};

// Có glow hay không phụ thuộc loại entity:
// - automation.xxx (1 hoặc nhiều): state on/off là TRẠNG THÁI THẬT, bền vững
//   -> bám thẳng theo state, luôn đúng dù ai đổi từ nơi khác. Với NHIỀU
//   automation trong cùng 1 nút, icon chỉ sáng khi TẤT CẢ đang bật (coi là
//   "kịch bản đang áp dụng đầy đủ"); nếu chỉ một phần bật thì coi như chưa
//   đủ điều kiện sáng, và lần bấm kế tiếp sẽ bật nốt phần còn thiếu (xem
//   _activateScene) thay vì tắt hết.
// - scene.xxx / script.xxx: không có state bền vững phản ánh đúng ý "đang áp
//   dụng kịch bản" -> dùng hiệu ứng pulse tạm thời (xem _pulseScene).
FloorplanCard.prototype._isSceneActive = function _isSceneActive(scene, i) {
  if (!scene || !scene.entity) return false;
  const entities = toArray(scene.entity);
  const automationEntities = entities.filter((e) => e.split('.')[0] === 'automation');
  if (automationEntities.length) {
    return automationEntities.every((e) => !isUnavailable(this._hass, e) && this._hass.states[e].state === 'on');
  }
  return !!(this._activeScenes && this._activeScenes.has(i));
};

FloorplanCard.prototype._statusBarTemplate = function _statusBarTemplate() {
  const items = this._config.status_bar || [];
  const mb = this._config.media_bar;
  const hasMediaBar = mb && mb.buttons && mb.buttons.length;
  if (!items.length && !hasMediaBar) return '';
  const open = !!this._mediaBarOpen;
  return `
    <div class="status-bar">
      ${hasMediaBar ? `
        <div class="media-bar ${open ? 'open' : ''}">
          <button class="media-bar-toggle" data-role="media-bar-toggle" title="Trung tâm điều khiển">
            <ha-icon icon="${escapeHtml(open ? 'mdi:close' : (mb.icon || 'mdi:play-circle-outline'))}"></ha-icon>
          </button>
          <div class="media-bar-buttons">
            ${mb.buttons.map((b, i) => `
              <button class="media-bar-btn" data-role="media-bar-btn" data-index="${i}" title="${escapeHtml(b.label || '')}">
                <ha-icon icon="${escapeHtml(b.icon || 'mdi:apps')}"></ha-icon>
              </button>`).join('')}
          </div>
        </div>` : ''}
      ${items.map((it) => {
        const val = isUnavailable(this._hass, it.entity)
          ? '--'
          : `${fmtNumber(this._hass, it.entity, 1)}${it.unit || ''}`;
        return `
          <div class="status-item" data-role="status-item" data-entity="${escapeHtml(it.entity || '')}" title="${escapeHtml(it.label || '')}">
            <ha-icon icon="${escapeHtml(it.icon || 'mdi:information')}"></ha-icon>
            <span class="status-value">${escapeHtml(val)}</span>
          </div>`;
      }).join('')}
    </div>`;
};

/* --------------------------- SVG line sync --------------------------- */

// Cổng ra vào là hành động nhạy cảm (an ninh) -> cố tình KHÔNG cho phép chỉ chạm
// (tap) là kích hoạt, để tránh bấm nhầm. Người dùng phải thực sự kéo/vuốt thumb
// đi đủ xa đúng hướng thì mới gọi service; nếu buông giữa chừng, thumb tự trượt
// về vị trí ban đầu. Áp dụng cho cả 3 kiểu track (xem data-slide-mode):
//  - "cover": 1 entity cover duy nhất, biết trạng thái mở/đóng thật.
//  - "switch-directional": 3 switch độc lập NHƯNG có gate.state_entity riêng
//    để biết trạng thái -> cơ chế y hệt "cover", chỉ khác service được gọi.
//  - "switch-neutral": 3 switch độc lập, KHÔNG có state_entity nào -> không
//    biết trạng thái hiện tại, thumb bắt đầu ở giữa track, vuốt trái = mở,
//    vuốt phải = đóng.
FloorplanCard.prototype._bindGateSlide = function _bindGateSlide() {
  const thumb = this.shadowRoot.querySelector('[data-role="gate-slide-thumb"]');
  if (!thumb) return;
  const track = thumb.closest('.gate-slide-track');
  if (!track) return;
  const mode = track.dataset.slideMode || 'cover';
  if (mode === 'switch-neutral') {
    this._bindGateSlideNeutral(thumb, track);
  } else {
    this._bindGateSlideDirectional(thumb, track, mode);
  }
};

// Cơ chế "biết trạng thái": thumb đứng hẳn về 1 phía theo trạng thái hiện tại,
// chỉ cho vuốt sang phía đối diện. Dùng chung cho mode "cover" và
// "switch-directional" — khác nhau duy nhất ở domain/service được gọi lúc buông.
FloorplanCard.prototype._bindGateSlideDirectional = function _bindGateSlideDirectional(thumb, track, mode) {
  const isOpen = track.dataset.open === '1';
  const pad = 2;
  // Vị trí nghỉ (trái/phải theo isOpen) đã được CSS lo (xem
  // .gate-slide-track[data-open="..."] .gate-slide-thumb) -> KHÔNG set left ở
  // đây nữa. minLeft/maxLeft/startLeft chỉ được đo THẬT lúc pointerdown, vì
  // đó là thời điểm chắc chắn phần tử đã visible/có layout đúng (người dùng
  // đang chạm được vào nó).
  let minLeft = pad;
  let maxLeft = pad;
  let startLeft = pad;
  let startX = 0;
  let currentLeft = pad;

  const onMove = (ev) => {
    const delta = ev.clientX - startX;
    currentLeft = Math.min(maxLeft, Math.max(minLeft, startLeft + delta));
    thumb.style.transition = 'none';
    thumb.style.left = `${currentLeft}px`;
  };

  const onUp = (ev) => {
    try { thumb.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
    thumb.removeEventListener('pointermove', onMove);
    thumb.removeEventListener('pointerup', onUp);
    thumb.removeEventListener('pointercancel', onUp);
    thumb.style.transition = 'left .18s ease';
    const travel = Math.max(1, maxLeft - minLeft);
    // progress: 0 = chưa kéo gì, 1 = đã kéo hết cỡ đúng hướng cần thiết
    const progress = isOpen ? (currentLeft - minLeft) / travel : (maxLeft - currentLeft) / travel;
    if (progress > 0.6) {
      thumb.style.left = `${isOpen ? maxLeft : minLeft}px`;
      if (mode === 'cover') {
        this._callService(track.dataset.entity, 'cover', isOpen ? 'close_cover' : 'open_cover');
      } else {
        const entity = isOpen ? track.dataset.closeEntity : track.dataset.openEntity;
        this._callService(entity, 'switch', 'turn_on');
      }
    } else {
      thumb.style.left = `${startLeft}px`;
    }
  };

  thumb.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Đo layout thật ngay lúc chạm — track/thumb chắc chắn đã visible ở đây.
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const trackWidth = trackRect.width || 176;
    const thumbSize = thumbRect.width || 28;
    minLeft = pad;
    maxLeft = Math.max(minLeft, trackWidth - thumbSize - pad);
    startLeft = isOpen ? minLeft : maxLeft;
    // Chuyển từ vị trí nghỉ do CSS (left/right:auto) sang left px cụ thể để
    // bắt đầu kéo tay, tránh xung đột với rule CSS ở trên.
    thumb.style.right = 'auto';
    thumb.style.transition = 'none';
    thumb.style.left = `${startLeft}px`;
    startX = ev.clientX;
    currentLeft = startLeft;
    try { thumb.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
    thumb.addEventListener('pointercancel', onUp);
  });
};

// Cơ chế "trung tính" (không biết trạng thái hiện tại): thumb bắt đầu ở CHÍNH
// GIỮA track. Vuốt đủ xa sang trái -> gọi switch mở; vuốt đủ xa sang phải ->
// gọi switch đóng. Buông ở đâu cũng luôn trượt lại giữa (không có "trạng thái
// cuối" nào để giữ, vì đây là lệnh tức thời chứ không phải toggle).
FloorplanCard.prototype._bindGateSlideNeutral = function _bindGateSlideNeutral(thumb, track) {
  const pad = 2;
  // Sau khi vuốt trúng lệnh, giữ thumb đứng yên ở vị trí đã kéo tới trong
  // ngần này ms để người dùng thấy rõ lệnh đã ghi nhận, rồi mới trượt êm về
  // giữa — thay vì trượt về ngay lập tức khiến dễ tưởng chưa bấm trúng.
  const HOLD_MS = 2000;
  // Vị trí nghỉ (chính giữa) đã được CSS lo (.gate-slide-track.neutral
  // .gate-slide-thumb { left:50% }) -> KHÔNG set left ở đây nữa. Đây chính là
  // hàm gây ra bug "chấm lệch trái" trong ảnh chụp: trước đây track.clientWidth
  // đọc lúc bind có thể = 0 (card chưa visible tại thời điểm _render() vừa
  // set innerHTML), rơi vào fallback 150px thay vì 176px thật trong CSS,
  // khiến centerLeft tính sai và lệch tâm ~13px, không có gì tính lại sau đó.
  let minLeft = pad;
  let maxLeft = pad;
  let centerLeft = pad;
  let startX = 0;
  let currentLeft = pad;
  let holdTimer = null;

  const returnToCenter = () => {
    holdTimer = null;
    thumb.classList.remove('confirmed');
    thumb.style.transition = 'left .18s ease';
    thumb.style.left = `${centerLeft}px`;
  };

  const onMove = (ev) => {
    const delta = ev.clientX - startX;
    currentLeft = Math.min(maxLeft, Math.max(minLeft, centerLeft + delta));
    thumb.style.transition = 'none';
    thumb.style.left = `${currentLeft}px`;
  };

  const onUp = (ev) => {
    try { thumb.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
    thumb.removeEventListener('pointermove', onMove);
    thumb.removeEventListener('pointerup', onUp);
    thumb.removeEventListener('pointercancel', onUp);
    const halfTravel = Math.max(1, centerLeft - minLeft);
    const delta = currentLeft - centerLeft;
    const progress = Math.abs(delta) / halfTravel;
    if (progress > 0.6) {
      const entity = delta < 0 ? track.dataset.openEntity : track.dataset.closeEntity;
      this._callService(entity, 'switch', 'turn_on');
      // Vuốt trúng lệnh -> giữ nguyên vị trí đã kéo tới (không trượt về ngay)
      // và bật hiệu ứng xác nhận màu xanh lá trong HOLD_MS.
      thumb.style.transition = 'none';
      thumb.style.left = `${currentLeft}px`;
      thumb.classList.add('confirmed');
      holdTimer = setTimeout(returnToCenter, HOLD_MS);
    } else {
      // Vuốt chưa đủ xa -> không có gì để xác nhận, trượt về giữa ngay.
      thumb.style.transition = 'left .18s ease';
      thumb.style.left = `${centerLeft}px`;
    }
  };

  thumb.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Nếu đang giữa lúc "chờ trượt về giữa" mà người dùng kéo tiếp -> huỷ chờ,
    // cho tương tác mới bắt đầu ngay lập tức.
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; thumb.classList.remove('confirmed'); }
    // Đo layout thật ngay lúc chạm, giống _bindGateSlideDirectional ở trên.
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const trackWidth = trackRect.width || 176;
    const thumbSize = thumbRect.width || 28;
    minLeft = pad;
    maxLeft = Math.max(minLeft, trackWidth - thumbSize - pad);
    centerLeft = (minLeft + maxLeft) / 2;
    thumb.style.right = 'auto';
    // QUAN TRỌNG: huỷ margin-left:-14px mà CSS ".neutral" dùng để canh giữa
    // lúc nghỉ (left:50% + margin-left:-14px). Nếu không huỷ, margin-left cũ
    // vẫn cộng dồn vào left px tuyệt đối bên dưới -> toàn bộ track bị dịch
    // trái thêm 14px so với phép tính, khiến kéo sang phải (đóng) luôn hụt
    // mất khoảng đó trước khi chạm mép phải (đây chính là lý do "đóng không
    // đi hết kịch" trong khi "mở" vẫn có vẻ ổn).
    thumb.style.marginLeft = '0';
    thumb.style.transition = 'none';
    thumb.style.left = `${centerLeft}px`;
    startX = ev.clientX;
    currentLeft = centerLeft;
    try { thumb.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
    thumb.addEventListener('pointercancel', onUp);
  });
};

FloorplanCard.prototype._observeResize = function _observeResize() {
  if (this._resizeObserver) this._resizeObserver.disconnect();
  const wrapper = this.shadowRoot.querySelector('.wrapper');
  if (!wrapper) return;
  // Một số WebView đời cũ (ví dụ đầu Android chạy Android 6/7 gắn tường) không
  // có ResizeObserver. Bỏ qua thay vì throw — throw ở đây từng có thể khiến
  // cả _render() coi như fail (xem _safeRender) dù nội dung đã kịp gán vào DOM.
  if (typeof ResizeObserver === 'undefined') return;
  this._resizeObserver = new ResizeObserver(() => this._updateSvgViewbox());
  this._resizeObserver.observe(wrapper);
};

FloorplanCard.prototype._updateSvgViewbox = function _updateSvgViewbox() {
  const wrapper = this.shadowRoot.querySelector('.wrapper');
  const svg = this.shadowRoot.querySelector('.overlay-svg');
  if (!wrapper || !svg) return;
  const w = wrapper.clientWidth;
  const h = wrapper.clientHeight;
  if (!w || !h) return;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.querySelectorAll('[data-x1-pct]').forEach((line) => {
    line.setAttribute('x1', (parseFloat(line.dataset.x1Pct) / 100) * w);
    line.setAttribute('y1', (parseFloat(line.dataset.y1Pct) / 100) * h);
    line.setAttribute('x2', (parseFloat(line.dataset.x2Pct) / 100) * w);
    line.setAttribute('y2', (parseFloat(line.dataset.y2Pct) / 100) * h);
  });
  svg.querySelectorAll('[data-cx-pct]').forEach((dot) => {
    dot.setAttribute('cx', (parseFloat(dot.dataset.cxPct) / 100) * w);
    dot.setAttribute('cy', (parseFloat(dot.dataset.cyPct) / 100) * h);
  });
  // Vệt đường đi robot (trail): danh sách điểm "x,y x,y ..." theo % ảnh, quy
  // đổi sang pixel thực giống hệt cơ chế data-x-pct/data-cx-pct ở trên.
  svg.querySelectorAll('[data-points-pct]').forEach((poly) => {
    const points = poly.dataset.pointsPct
      .split(' ')
      .filter(Boolean)
      .map((pair) => {
        const [px, py] = pair.split(',').map(Number);
        return `${(px / 100) * w},${(py / 100) * h}`;
      })
      .join(' ');
    poly.setAttribute('points', points);
  });
};

/* ------------------------------ Actions ------------------------------ */

FloorplanCard.prototype._handleClick = function _handleClick(e) {
  const path = e.composedPath();
  const el = path.find((n) => n.nodeType === 1 && n.dataset && n.dataset.role);
  if (!el || !this._hass) return;
  const role = el.dataset.role;
  if (role === 'gate-btn') this._callService(el.dataset.gateEntity, 'switch', 'turn_on');
  else if (role === 'room-toggle') this._toggleRoom(el.dataset.roomId);
  else if (role === 'room-info') this._openMoreInfo(el.dataset.entity);
  else if (role === 'topbar-btn') this._handleTopBarAction(this._config.top_bar_buttons[Number(el.dataset.index)]);
  else if (role === 'scene-btn') this._activateScene(this._config.scenes[Number(el.dataset.index)], Number(el.dataset.index));
  else if (role === 'status-item') { if (el.dataset.entity) this._openMoreInfo(el.dataset.entity); }
  else if (role === 'robot-info') this._openMoreInfo(el.dataset.entity);
  else if (role === 'popup-close') this._closeContentPopup();
  else if (role === 'media-bar-toggle') { this._mediaBarOpen = !this._mediaBarOpen; this._render(); }
  else if (role === 'media-bar-btn') {
    const mb = this._config.media_bar;
    const btn = mb && mb.buttons && mb.buttons[Number(el.dataset.index)];
    if (btn && btn.popup) this._openBrowserModPopup(btn.popup);
    this._mediaBarOpen = false;
    this._render();
  }
};

FloorplanCard.prototype._toggleRoom = function _toggleRoom(roomId) {
  const room = (this._config.rooms || []).find((r) => r.id === roomId);
  if (!room || !room.light_entities || !room.light_entities.length) return;
  const on = anyOn(this._hass, room.light_entities);
  this._hass.callService('light', on ? 'turn_off' : 'turn_on', { entity_id: room.light_entities });
};

FloorplanCard.prototype._openMoreInfo = function _openMoreInfo(entityId) {
  if (!entityId) return;
  fireEvent(this, 'hass-more-info', { entityId });
};

FloorplanCard.prototype._callService = function _callService(entityId, domain, service) {
  if (!entityId) return;
  this._hass.callService(domain, service, { entity_id: entityId });
};

// Mở popup của custom component "browser_mod" (nếu đã cài). Cơ chế này mô phỏng
// đúng những gì Home Assistant làm nội bộ cho MỌI card khi cấu hình
// `tap_action: {action: fire-dom-event, browser_mod: {...}}`: bắn 1 sự kiện DOM
// tên "ll-custom" mang theo config, nổi bọt (bubble) lên tới document, nơi
// browser_mod đang lắng nghe sẵn để tự xử lý phần còn lại. Nhờ vậy popup mở ra
// giống HỆT 100% (kể cả mic ghi âm, media control, báo thức...) mà floorplan-card
// không cần biết/viết lại bất kỳ logic gì bên trong — chỉ cần dán nguyên khối
// "content" (title/size/style/content) mà bạn đã có sẵn vào config, dưới field
// media_bar.buttons[].popup.
FloorplanCard.prototype._openBrowserModPopup = function _openBrowserModPopup(popup) {
  if (!popup) return;
  fireEvent(this, 'll-custom', { browser_mod: { service: 'popup', data: popup } });
};

FloorplanCard.prototype._handleTopBarAction = function _handleTopBarAction(btn) {
  if (!btn) return;
  switch (btn.action) {
    case 'navigate':
      if (btn.navigation_path) {
        history.pushState(null, '', btn.navigation_path);
        fireEvent(window, 'location-changed');
      }
      break;
    case 'more-info':
      this._openMoreInfo(btn.entity);
      break;
    case 'camera':
      // Giữ tương thích ngược với config cũ dùng action: camera
      this._openCameraPopup(btn.entity);
      break;
    case 'popup':
      if (btn.popup_type === 'content') {
        this._openContentPopup(btn.popup_title, btn.popup_content, btn.popup_image);
      } else {
        // Mặc định (hoặc popup_type: camera): mở popup khung camera nhỏ gọn,
        // không viền, tự dựng ngay trong card (khác dialog more-info mặc định
        // của Home Assistant vốn to và có khung/tiêu đề chuẩn của hệ thống).
        this._openCameraPopup(btn.entity);
      }
      break;
    case 'toggle':
      if (btn.entity) this._hass.callService('homeassistant', 'toggle', { entity_id: btn.entity });
      break;
    case 'call-service':
      if (btn.service) {
        const [domain, service] = btn.service.split('.');
        if (domain && service) this._hass.callService(domain, service, btn.service_data || (btn.entity ? { entity_id: btn.entity } : {}));
      }
      break;
    case 'url':
      if (btn.url) window.open(btn.url, '_blank');
      break;
    default:
      break;
  }
};

FloorplanCard.prototype._activateScene = function _activateScene(scene, i) {
  if (!scene || !scene.entity) return;
  const entities = toArray(scene.entity);
  if (!entities.length) return;

  // Gom theo domain vì 1 nút giờ có thể chứa nhiều entity khác loại cùng lúc
  // (vd 2 automation, hoặc 1 script + 1 scene) — mỗi domain xử lý theo đúng
  // cách của nó, có thể gọi chung 1 service với danh sách entity_id.
  const byDomain = {};
  entities.forEach((e) => {
    const domain = e.split('.')[0];
    (byDomain[domain] = byDomain[domain] || []).push(e);
  });

  if (byDomain.automation && byDomain.automation.length) {
    // Bật/tắt ĐỒNG LOẠT theo cùng 1 chiều (không toggle riêng lẻ từng cái):
    // nếu tất cả đang bật -> tắt hết; ngược lại (kể cả mới bật 1 phần) -> bật
    // hết. Tránh trường hợp toggle riêng lẻ làm chúng lệch pha nhau (A đang
    // bật B đang tắt, bấm 1 nút mà A tắt B bật thì vô nghĩa với người dùng).
    const allOn = this._isSceneActive(scene, i);
    this._hass.callService('homeassistant', allOn ? 'turn_off' : 'turn_on', { entity_id: byDomain.automation });
  }
  if (byDomain.script && byDomain.script.length) {
    this._hass.callService('script', 'turn_on', { entity_id: byDomain.script });
  }
  if (byDomain.scene && byDomain.scene.length) {
    this._hass.callService('scene', 'turn_on', { entity_id: byDomain.scene });
  }

  // Pulse tạm chỉ cần khi KHÔNG có automation trong danh sách — automation đã
  // có glow bám state thật, không cần hiệu ứng tạm chồng lên.
  if (!byDomain.automation || !byDomain.automation.length) this._pulseScene(i);
};

// Bật hiệu ứng glow xoay viền cho nút scene tại index `i` trong khoảng
// SCENE_PULSE_MS, rồi tự tắt và render lại. Scene entity thường không có
// state "on/off" để dựa vào (bắn xong là xong), nên đây là phản hồi thị giác
// tạm thời xác nhận "đã bấm" thay vì phản ánh trạng thái thực của kịch bản.
// Bấm lại trong lúc đang glow sẽ reset timer, không cộng dồn hiệu ứng.
const SCENE_PULSE_MS = 1500;
FloorplanCard.prototype._pulseScene = function _pulseScene(i) {
  if (!Number.isInteger(i)) return;
  if (!this._activeScenes) this._activeScenes = new Set();
  if (!this._scenePulseTimers) this._scenePulseTimers = {};
  this._activeScenes.add(i);
  if (this._scenePulseTimers[i]) clearTimeout(this._scenePulseTimers[i]);
  this._scenePulseTimers[i] = setTimeout(() => {
    this._activeScenes.delete(i);
    delete this._scenePulseTimers[i];
    this._safeRender();
  }, SCENE_PULSE_MS);
  this._safeRender();
};

/* --------------------------- Popup nội dung tuỳ chỉnh --------------------------- */
// Dùng cho nút top-bar action:"popup" với popup_type:"content" — không gắn với
// entity nào, chỉ hiển thị tiêu đề/nội dung/ảnh tự do do người dùng khai báo
// trong visual editor, tự dựng popup ngay trong card (khác với popup camera
// dùng dialog more-info gốc của Home Assistant).

FloorplanCard.prototype._openContentPopup = function _openContentPopup(title, content, image) {
  this._contentPopup = { kind: 'content', title: title || '', content: content || '', image: image || '' };
  this._render();
};

FloorplanCard.prototype._openCameraPopup = function _openCameraPopup(entity) {
  this._contentPopup = { kind: 'camera', entity: entity || '' };
  this._render();
};

FloorplanCard.prototype._closeContentPopup = function _closeContentPopup() {
  this._contentPopup = null;
  this._render();
};

// Với entity domain "camera", hass.states[entity].attributes.entity_picture đã
// kèm sẵn token truy cập tạm thời -> tận dụng token đó để dựng URL luồng MJPEG
// trực tiếp (/api/camera_proxy_stream), thay vì chỉ lấy ảnh tĩnh (snapshot).
FloorplanCard.prototype._cameraStreamUrl = function _cameraStreamUrl(entity) {
  if (!entity || !this._hass || !this._hass.states[entity]) return '';
  const picture = this._hass.states[entity].attributes.entity_picture;
  if (!picture) return '';
  const tokenMatch = picture.match(/token=([^&]+)/);
  const token = tokenMatch ? tokenMatch[1] : '';
  return `/api/camera_proxy_stream/${entity}${token ? `?token=${token}` : ''}`;
};

FloorplanCard.prototype._contentPopupTemplate = function _contentPopupTemplate() {
  if (!this._contentPopup) return '';
  const p = this._contentPopup;

  if (p.kind === 'camera') {
    const streamSrc = this._cameraStreamUrl(p.entity);
    return `
      <div class="popup-backdrop popup-backdrop--camera" data-role="popup-close">
        <div class="popup-camera-box" data-role="popup-box">
          <button class="popup-camera-close" data-role="popup-close" title="Đóng">✕</button>
          ${streamSrc
            ? `<img class="popup-camera-img" src="${streamSrc}" alt="" />`
            : `<div class="popup-camera-fallback">Không tìm thấy hoặc không đọc được luồng camera<br>(${escapeHtml(p.entity || '')})</div>`}
        </div>
      </div>
    `;
  }

  const { title, content, image } = p;
  // Giữ xuống dòng người dùng nhập trong textarea: escape trước rồi mới thay \n bằng <br>
  const safeContent = escapeHtml(content).replace(/\n/g, '<br>');
  return `
    <div class="popup-backdrop" data-role="popup-close">
      <div class="popup-box" data-role="popup-box">
        <div class="popup-head">
          <div class="popup-title">${escapeHtml(title)}</div>
          <button class="popup-close-btn" data-role="popup-close" title="Đóng">✕</button>
        </div>
        ${image ? `<img class="popup-image" src="${escapeHtml(image)}" alt="" />` : ''}
        ${content ? `<div class="popup-content">${safeContent}</div>` : ''}
      </div>
    </div>
  `;
};

/* --------------------------- Stub config --------------------------- */

const DEFAULT_STUB_CONFIG = {
  type: `custom:${CARD_TAG}`,
  background_image: '/local/floorplan/house.png',
  aspect_ratio: '16/9',
  rooms: [
    {
      id: 'living',
      name: 'Phòng khách',
      icon: 'mdi:sofa',
      temp_entity: 'sensor.living_temperature',
      humidity_entity: 'sensor.living_humidity',
      light_entities: [
        'light.den_tran_phong_khach', 'light.den_1_phong_khach', 'light.den_hien_phong_khach',
        'light.den_san_phong_khach', 'light.den_tu_phong_khach', 'light.den_tho_phong_khach',
        'light.den_1_phong_khach_2', 'light.wled_network',
      ],
      label_position: { x: 14, y: 17 },
      anchor_position: { x: 31, y: 21 },
    },
    {
      id: 'nhabe',
      name: 'Phòng bếp + ăn',
      icon: 'mdi:silverware-fork-knife',
      temp_entity: 'sensor.dieu_hoa_phong_bep_kitchen_temperature',
      humidity_entity: 'sensor.dieu_hoa_phong_bep_kitchen_humidity',
      light_entities: [
        'light.den_tran_nha_bep', 'light.den_1_nha_bep', 'light.den_san_nha_bep', 'light.den_tha_nha_bep',
        'light.den_hien_nha_bep', 'light.den_trang_tri_hien_bep', 'light.den_hanh_lang',
        'light.fan_light_kitchen_2', 'light.wled_network',
      ],
      label_position: { x: 38, y: 7 },
      anchor_position: { x: 47, y: 15 },
    },
    {
      id: 'phongngu',
      name: 'Phòng ngủ',
      icon: 'mdi:bed',
      temp_entity: 'sensor.bedroom_temperature',
      humidity_entity: 'sensor.bedroom_humidity',
      light_entities: [
        'light.den_1_phong_ngu', 'light.den_2_phong_ngu', 'light.den_san_phong_ngu', 'light.bedroom_status_light',
      ],
      label_position: { x: 78, y: 15 },
      anchor_position: { x: 70, y: 22 },
    },
    {
      id: 'nhatam',
      name: 'Phòng tắm',
      icon: 'mdi:shower',
      temp_entity: '',
      humidity_entity: '',
      light_entities: ['light.den_nha_tam', 'light.den_wc', 'light.den_san'],
      label_position: { x: 55, y: 27 },
      anchor_position: { x: 62, y: 31 },
    },
    {
      id: 'office',
      name: 'Phòng làm việc',
      icon: 'mdi:laptop',
      temp_entity: 'sensor.office_temperature',
      humidity_entity: 'sensor.office_humidity',
      light_entities: ['light.den_1_office', 'light.wled_network'],
      label_position: { x: 86, y: 41 },
      anchor_position: { x: 77, y: 44 },
    },
  ],
  gate: {
    entity: 'cover.cong_chinh',
    name: 'Cổng chính',
    position: { x: 31, y: 62 },
    anchor_position: { x: 31, y: 54 },
    open_label: 'Vuốt để mở',
    close_label: 'Vuốt để đóng',
  },
  top_bar_buttons: [
    {
      icon: 'mdi:doorbell-video', label: 'Chuông cửa', action: 'popup', popup_type: 'camera', entity: 'camera.chuong_cua',
      position: { x: 18, y: 48 }, anchor_position: { x: 23, y: 57 },
    },
    { icon: 'mdi:cctv', label: 'Camera cổng', action: 'popup', popup_type: 'camera', entity: 'camera.cong_chinh' },
    {
      icon: 'mdi:information-outline', label: 'Trợ giúp', action: 'popup', popup_type: 'content',
      popup_title: 'Trợ giúp nhanh',
      popup_content: 'Chạm vào tên phòng để bật/tắt đèn.\nChạm vào ô nhiệt độ/độ ẩm để xem chi tiết cảm biến.',
    },
    { icon: 'mdi:shield-home', label: 'An ninh', action: 'navigate', navigation_path: '/lovelace/security' },
    { icon: 'mdi:flash', label: 'Năng lượng', action: 'navigate', navigation_path: '/lovelace/energy' },
    { icon: 'mdi:cog', label: 'Cài đặt', action: 'navigate', navigation_path: '/config/dashboard' },
  ],
  scenes: [
    { icon: 'mdi:home', label: 'Về nhà', entity: 'scene.ve_nha' },
    { icon: 'mdi:weather-night', label: 'Đi ngủ', entity: 'scene.di_ngu' },
    { icon: 'mdi:account-group', label: 'Tiếp khách', entity: 'scene.tiep_khach' },
    { icon: 'mdi:exit-run', label: 'Ra ngoài', entity: 'scene.ra_ngoai' },
  ],
  status_bar: [
    { icon: 'mdi:thermometer', label: 'Nhiệt độ ngoài trời', entity: 'sensor.outdoor_temperature', unit: '°C' },
    { icon: 'mdi:water-percent', label: 'Độ ẩm ngoài trời', entity: 'sensor.outdoor_humidity', unit: '%' },
    { icon: 'mdi:account-multiple', label: 'Người trong nhà', entity: 'sensor.nguoi_trong_nha', unit: ' người' },
    { icon: 'mdi:lightning-bolt', label: 'Tiêu thụ điện hiện tại', entity: 'sensor.tong_cong_suat', unit: ' kW' },
    { icon: 'mdi:cctv', label: 'Camera hoạt động', entity: 'sensor.camera_hoat_dong', unit: '' },
  ],
};

/* ============================ Visual Editor ============================ */

const ACTION_OPTIONS = [
  { value: 'navigate', label: 'Chuyển trang (navigate)' },
  { value: 'more-info', label: 'Mở More-info (entity)' },
  { value: 'popup', label: 'Popup (dùng cho camera hoặc popup nội dung)' },
  { value: 'toggle', label: 'Toggle (entity)' },
  { value: 'call-service', label: 'Gọi service' },
  { value: 'url', label: 'Mở URL' },
];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

class FloorplanCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._positionEditorOpen = false;
    this._dragState = null;
    this._upgradeProperty('hass');
  }

  _upgradeProperty(prop) {
    if (Object.prototype.hasOwnProperty.call(this, prop)) {
      const value = this[prop];
      delete this[prop];
      this[prop] = value;
    }
  }

  setConfig(config) {
    this._config = this._normalize(migrateAnchors({
      aspect_ratio: '16/9',
      rooms: [],
      top_bar_buttons: [],
      scenes: [],
      status_bar: [],
      ...config,
    }));
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll('ha-entity-picker').forEach((el) => { el.hass = hass; });
    this.shadowRoot.querySelectorAll('ha-icon-picker').forEach((el) => { el.hass = hass; });
  }

  get hass() {
    return this._hass;
  }

  // Ép "type" và "background_image" luôn nằm ở đầu object config, tránh việc
  // spread {...defaults, ...config} đẩy 2 field này xuống cuối mỗi lần lưu.
  _normalize(cfg) {
    const orderedKeys = ['type', 'background_image', 'aspect_ratio', 'rooms', 'gate', 'top_bar_buttons', 'scenes', 'status_bar'];
    const ordered = {};
    orderedKeys.forEach((k) => { if (cfg[k] !== undefined) ordered[k] = cfg[k]; });
    Object.keys(cfg).forEach((k) => { if (!(k in ordered)) ordered[k] = cfg[k]; });
    return clone(ordered);
  }

  _emitChange() {
    fireEvent(this, 'config-changed', { config: this._normalize(this._config) });
  }

  _update(mutator) {
    mutator(this._config);
    this._config = this._normalize(this._config);
    this._emitChange();
    this._render();
  }

  /* ---------------------------- Main render ---------------------------- */

  _render() {
    if (!this.shadowRoot || !this._config) return;
    if (this._positionEditorOpen) {
      this._renderPositionEditor();
      return;
    }
    const cfg = this._config;
    this.shadowRoot.innerHTML = `
      <style>${EDITOR_STYLE}</style>
      <div class="editor">
        <div class="credit">🏠 <strong>Floorplan Card</strong>
          <span class="credit-sub">v${CARD_VERSION} Designed by @doanlong1412 from 🇻🇳 Vietnam</span>
        </div>
        <div class="credit-links">
          <a class="credit-link tiktok" href="https://www.tiktok.com/@long.1412" target="_blank" rel="noopener noreferrer">
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;">
              <path d="M27.2 7.2a7.6 7.6 0 0 1-7.6-7.6h-5v21.5a3.6 3.6 0 1 1-3.6-3.6c.33 0 .65.05.96.13V12.5a8.6 8.6 0 1 0 8.24 8.6V11.5a12.6 12.6 0 0 0 7.6 2.5V8.6a7.66 7.66 0 0 1-.54-.01z" fill="white"/>
              <path d="M27.2 7.2a7.6 7.6 0 0 1-7.6-7.6h-3v21.5a3.6 3.6 0 1 1-2.6-3.46V12.5a8.6 8.6 0 1 0 7.6 8.6V11.5a12.6 12.6 0 0 0 5.6 1.5V8.6a7.6 7.6 0 0 1 0 0z" fill="#69C9D0" fill-opacity="0.5"/>
              <path d="M13 21.1a3.6 3.6 0 1 0 3.6 3.6V3.6h-3v20.95a3.61 3.61 0 0 0-.6-.45z" fill="#EE1D52" fill-opacity="0.6"/>
            </svg>
            <div style="min-width:0;">
              <div class="credit-link-title">TikTok</div>
              <div class="credit-link-sub">@long.1412</div>
            </div>
          </a>
          <a class="credit-link paypal" href="http://paypal.me/doanlong1412" target="_blank" rel="noopener noreferrer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;">
              <path d="M19.5 6.5C19.5 9.5 17.5 11.5 14.5 11.5H12L11 16H8L10 6H14.5C17.3 6 19.5 4 19.5 6.5Z" fill="#009cde"/>
              <path d="M17.5 4C17.5 7 15.5 9 12.5 9H10L9 14H6L8 4H12.5C15.3 4 17.5 2 17.5 4Z" fill="#ffffff" fill-opacity="0.85"/>
              <path d="M7 16H4.5L6.5 6H9L7 16Z" fill="#ffffff" fill-opacity="0.5"/>
            </svg>
            <div style="min-width:0;">
              <div class="credit-link-title">Donate ☕</div>
              <div class="credit-link-sub">PayPal</div>
            </div>
          </a>
        </div>
        <div class="section">
          <div class="section-title">Ảnh nền &amp; khung</div>
          <label>Đường dẫn ảnh nền (background_image)
            <input type="text" data-field="background_image" value="${escapeHtml(cfg.background_image || '')}" placeholder="/local/floorplan/house.png" />
          </label>
          <label>Tỉ lệ khung ảnh (aspect_ratio)
            <input type="text" data-field="aspect_ratio" value="${escapeHtml(cfg.aspect_ratio || '16/9')}" placeholder="16/9" />
          </label>
          <button class="btn secondary" data-action="open-position-editor">📍 Chỉnh vị trí nhãn / điểm neo / cổng / nút top-bar</button>
        </div>

        <div class="section">
          <div class="section-title">Danh sách phòng (rooms)</div>
          ${cfg.rooms.map((r, i) => this._roomEditorTemplate(r, i)).join('')}
          <button class="btn" data-action="add-room">+ Thêm phòng</button>
        </div>

        <div class="section">
          <div class="section-title">Cổng chính (gate)</div>
          <label>Kiểu điều khiển
            <select data-field="gate.control_mode">
              <option value="cover" ${(!cfg.gate || cfg.gate.control_mode !== 'switches') ? 'selected' : ''}>1 entity cover (biết trạng thái mở/đóng, vuốt để điều khiển)</option>
              <option value="switches" ${cfg.gate && cfg.gate.control_mode === 'switches' ? 'selected' : ''}>3 switch độc lập (vuốt Mở/Đóng, bấm Dừng)</option>
            </select>
          </label>
          <label>Tên hiển thị
            <input type="text" data-field="gate.name" value="${escapeHtml((cfg.gate && cfg.gate.name) || '')}" placeholder="Cổng chính" />
          </label>
          ${this._gateTargetField(cfg.gate || {})}
        </div>

        <div class="section">
          <div class="section-title">Robot hút bụi (vị trí realtime) — tuỳ chọn</div>
          <div class="hint">Dùng cho tích hợp có camera bản đồ realtime (Dreame/Roborock/Xiaomi...). Cần hiệu chỉnh tối thiểu 4 điểm — nên rải vào các phòng khác nhau — để quy đổi toạ độ nội bộ của robot sang đúng vị trí trên ảnh của bạn, kể cả khi ảnh vẽ theo góc phối cảnh/isometric (không nhìn thẳng từ trên xuống). Càng nhiều điểm và càng rải đều khắp nhà, robot hiển thị càng chính xác ở mọi khu vực.</div>
          <label>Camera bản đồ (entity chứa thuộc tính toạ độ robot)
            <ha-entity-picker data-field="robot.entity" data-domains="camera"></ha-entity-picker>
          </label>
          <label>Entity robot hút bụi (mở more-info khi bấm icon) — tuỳ chọn
            <ha-entity-picker data-field="robot.vacuum_entity" data-domains="vacuum"></ha-entity-picker>
          </label>
          <div class="row">
            <label>Tên thuộc tính chứa toạ độ
              <input type="text" data-field="robot.position_attribute" value="${escapeHtml((cfg.robot && cfg.robot.position_attribute) || '')}" placeholder="ví dụ: vacuum_position" />
            </label>
            <label>Icon
              <ha-icon-picker data-field="robot.icon"></ha-icon-picker>
            </label>
          </div>
          <div class="hint">⚠️ Ô trên chỉ là gợi ý placeholder, không tự điền — bạn PHẢI tự gõ đúng tên thuộc tính (dò trong Developer Tools > States) thì card mới đọc được toạ độ.</div>
          <label>Entity trạng thái chi tiết (sensor "Status" nếu integration có) — tuỳ chọn
            <ha-entity-picker data-field="robot.status_entity" data-domains="sensor"></ha-entity-picker>
          </label>
          <label>Entity thông báo lỗi (sensor "Error" nếu integration có) — tuỳ chọn
            <ha-entity-picker data-field="robot.error_entity" data-domains="sensor"></ha-entity-picker>
          </label>
          <div class="hint">2 ô trên dùng để hiện bong bóng cảm xúc phía trên robot: 😴 khi ngủ, 🧹 khi đang dọn, 💧 khi lau nhà, 🔌 khi về sạc, 😵 kèm nội dung lỗi khi gặp sự cố... Không cấu hình thì bỏ trống, card sẽ tự suy ra từ trạng thái chuẩn (state) của entity robot hút bụi ở trên, kém chi tiết hơn 1 chút nhưng vẫn hoạt động.</div>
          <label style="display:flex; flex-direction:row; align-items:center; gap:6px;">
            <input type="checkbox" data-field="robot.swap_xy" ${cfg.robot && cfg.robot.swap_xy ? 'checked' : ''} />
            <span>Đảo trục X/Y (chỉ cần nếu bản đồ robot bị lật ngược/gương so với ảnh — xoay góc bình thường thì KHÔNG cần bật, đã tự bù trong hiệu chỉnh >=4 điểm)</span>
          </label>
          <label style="display:flex; flex-direction:row; align-items:center; gap:6px;">
            <input type="checkbox" data-field="robot.trail.enabled" ${cfg.robot && cfg.robot.trail && cfg.robot.trail.enabled ? 'checked' : ''} />
            <span>Vẽ vệt đường đi (trail) trong lúc dọn dẹp, mờ dần sau khi hoàn tất</span>
          </label>
          ${cfg.robot && cfg.robot.trail && cfg.robot.trail.enabled ? `
          <label>Số phút trước khi vệt biến mất hẳn sau khi robot dọn xong
            <input type="number" min="0" step="1" data-field="robot.trail.fade_after_minutes"
              value="${(cfg.robot.trail.fade_after_minutes !== undefined ? cfg.robot.trail.fade_after_minutes : 10)}" placeholder="10" />
          </label>
          <div class="hint">⚠️ Cần chọn "Entity robot hút bụi" ở trên (state chuẩn cleaning/docked/idle) thì trail mới biết lúc nào bắt đầu ghi và lúc nào tính là hoàn tất. Nếu bỏ trống entity đó, trail sẽ không hoạt động dù đã bật ở đây.</div>
          ` : ''}
          <div class="hint">
            <b>Cách hiệu chỉnh (khuyến nghị tối thiểu 4 điểm, mỗi điểm ở 1 phòng khác nhau, càng nhiều & càng rải đều càng chính xác):</b>
            Cho robot đứng tại 1 vị trí thực tế dễ nhận biết trong 1 phòng (ví dụ góc phòng khách) → bấm "📍 Lấy toạ độ hiện tại" ở điểm đó →
            mở "📍 Chỉnh vị trí" và kéo chấm hiệu chỉnh (màu tím) vào đúng điểm đó trên ảnh. Lặp lại cho từng phòng khác. Chỉ có 2-3 điểm thì card vẫn chạy được nhưng độ chính xác kém hơn nhiều, đặc biệt với ảnh vẽ phối cảnh/isometric.
          </div>
          ${((cfg.robot && cfg.robot.calibration) || []).map((c, ci) => this._robotCalEditorTemplate(c, ci)).join('')}
          <div class="hint">${(() => {
    const n = (cfg.robot && cfg.robot.calibration) ? cfg.robot.calibration.length : 0;
    if (n >= 4) return `✅ Đang có ${n} điểm hiệu chỉnh — dùng phép biến đổi phối cảnh (chính xác, có bù xoay/nghiêng).`;
    if (n === 2 || n === 3) return `⚠️ Đang có ${n} điểm — card vẫn chạy được (2 điểm dùng scale trục cũ, kém chính xác hơn với ảnh phối cảnh) nhưng nên thêm cho đủ 4+ để chính xác hơn.`;
    return 'Chưa có điểm hiệu chỉnh nào — cần tối thiểu 2 điểm (khuyến nghị 4+) để robot hiển thị.';
  })()}</div>
          <button class="btn" data-action="add-robot-cal">+ Thêm điểm hiệu chỉnh</button>
        </div>

        <div class="section">
          <div class="section-title">Thanh trên (top_bar_buttons)</div>
          ${cfg.top_bar_buttons.map((b, i) => this._topBarEditorTemplate(b, i)).join('')}
          <button class="btn" data-action="add-topbar">+ Thêm nút</button>
        </div>

        <div class="section">
          <div class="section-title">Kịch bản nhanh (scenes)</div>
          ${cfg.scenes.map((s, i) => this._sceneEditorTemplate(s, i)).join('')}
          <button class="btn" data-action="add-scene">+ Thêm kịch bản</button>
        </div>

        <div class="section">
          <div class="section-title">Thanh trạng thái dưới (status_bar)</div>
          ${cfg.status_bar.map((s, i) => this._statusEditorTemplate(s, i)).join('')}
          <button class="btn" data-action="add-status">+ Thêm ô trạng thái</button>
        </div>

        <div class="section">
          <div class="section-title">Media Bar (mở popup browser_mod) — tuỳ chọn</div>
          <div class="hint">
            Hiện 1 icon thu gọn ở góc dưới-trái (cạnh status_bar), bấm vào sẽ xẻ ngang hiện các icon con.
            Mỗi icon con khi bấm sẽ mở popup của <b>browser_mod</b> (bắt buộc đã cài custom component này) —
            y hệt cách hoạt động của <code>tap_action: fire-dom-event + browser_mod:</code> trên các card gốc khác.
          </div>
          <label>Icon nút gộp (lúc chưa mở)
            <ha-icon-picker data-field="media_bar.icon"></ha-icon-picker>
          </label>
          ${(cfg.media_bar && cfg.media_bar.buttons ? cfg.media_bar.buttons : []).map((b, i) => `
            <div class="card-block">
              <div class="card-block-head">
                <strong>${escapeHtml(b.label || 'Nút #' + (i + 1))}</strong>
                <button class="icon-btn" data-action="remove-media-bar-button" data-index="${i}" title="Xoá nút">✕</button>
              </div>
              <div class="row">
                <label>Icon
                  <ha-icon-picker data-field="media_bar.buttons.${i}.icon"></ha-icon-picker>
                </label>
                <label>Nhãn (tooltip)
                  <input type="text" data-field="media_bar.buttons.${i}.label" value="${escapeHtml(b.label || '')}" />
                </label>
              </div>
              <div class="hint">
                Nội dung popup (title/size/style/content) của nút này cần dán vào field
                <code>media_bar.buttons.${i}.popup</code> — bấm "Show code editor" ở cuối trang để dán nguyên khối
                YAML bạn đã có sẵn (giữ nguyên cấu trúc <code>content:</code>), form này chưa hỗ trợ chỉnh trực quan
                cho phần đó vì nó là cấu hình Lovelace lồng nhau tuỳ ý.
              </div>
            </div>
          `).join('')}
          <button class="btn" data-action="add-media-bar-button">+ Thêm nút</button>
        </div>
      </div>
    `;
    this._bindFormEvents();
  }

  _roomEditorTemplate(room, i) {
    return `
      <div class="card-block">
        <div class="card-block-head">
          <strong>${escapeHtml(room.name || room.id || 'Phòng #' + (i + 1))}</strong>
          <button class="icon-btn" data-action="remove-room" data-index="${i}" title="Xoá phòng">✕</button>
        </div>
        <div class="row">
          <label>Tên phòng
            <input type="text" data-field="rooms.${i}.name" value="${escapeHtml(room.name || '')}" />
          </label>
          <label>ID (duy nhất)
            <input type="text" data-field="rooms.${i}.id" value="${escapeHtml(room.id || '')}" />
          </label>
        </div>
        <label>Icon (mdi:...)
          <ha-icon-picker data-field="rooms.${i}.icon"></ha-icon-picker>
        </label>
        <label>Cảm biến nhiệt độ
          <ha-entity-picker data-field="rooms.${i}.temp_entity" data-domains="sensor"></ha-entity-picker>
        </label>
        <label>Cảm biến độ ẩm
          <ha-entity-picker data-field="rooms.${i}.humidity_entity" data-domains="sensor"></ha-entity-picker>
        </label>
        <label>Danh sách entity đèn (mỗi dòng / phẩy 1 entity_id)
          <textarea data-field="rooms.${i}.light_entities" rows="3" placeholder="light.den_1_phong_khach, light.den_tran_phong_khach">${escapeHtml((room.light_entities || []).join(', '))}</textarea>
        </label>
        <div class="hint">Vị trí nhãn/điểm neo: chỉnh trong "📍 Chỉnh vị trí" ở trên.</div>
      </div>
    `;
  }

  _robotCalEditorTemplate(c, ci) {
    const rp = c.robot || {};
    return `
      <div class="card-block">
        <div class="card-block-head">
          <strong>Điểm hiệu chỉnh ${ci + 1}${c.room ? ` — ${escapeHtml(c.room)}` : ''}</strong>
          <button class="icon-btn" data-action="remove-robot-cal" data-index="${ci}" title="Xoá điểm">✕</button>
        </div>
        <label>Ghi chú khu vực (không bắt buộc, chỉ để dễ nhớ — ví dụ "Phòng khách", "Bếp")
          <input type="text" data-field="robot.calibration.${ci}.room" value="${escapeHtml(c.room || '')}" placeholder="Phòng khách" />
        </label>
        <div class="row">
          <label>Toạ độ robot X
            <input type="number" step="any" data-field="robot.calibration.${ci}.robot.x" value="${rp.x !== undefined ? rp.x : ''}" />
          </label>
          <label>Toạ độ robot Y
            <input type="number" step="any" data-field="robot.calibration.${ci}.robot.y" value="${rp.y !== undefined ? rp.y : ''}" />
          </label>
        </div>
        <button class="btn secondary" data-action="capture-robot-cal" data-index="${ci}">📍 Lấy toạ độ hiện tại của robot</button>
        <div class="hint">${c.image
    ? `Vị trí trên ảnh: x=${c.image.x}%, y=${c.image.y}% — kéo chỉnh lại trong "📍 Chỉnh vị trí" nếu cần.`
    : 'Chưa có vị trí trên ảnh — mở "📍 Chỉnh vị trí" để kéo chấm hiệu chỉnh (màu tím) vào đúng điểm.'}</div>
      </div>
    `;
  }

  _topBarEditorTemplate(b, i) {
    return `
      <div class="card-block">
        <div class="card-block-head">
          <strong>${escapeHtml(b.label || 'Nút #' + (i + 1))}</strong>
          <button class="icon-btn" data-action="remove-topbar" data-index="${i}" title="Xoá">✕</button>
        </div>
        <div class="row">
          <label>Icon (mdi:...)
            <ha-icon-picker data-field="top_bar_buttons.${i}.icon"></ha-icon-picker>
          </label>
          <label>Nhãn
            <input type="text" data-field="top_bar_buttons.${i}.label" value="${escapeHtml(b.label || '')}" />
          </label>
        </div>
        <label>Hành động khi bấm
          <select data-field="top_bar_buttons.${i}.action">
            ${ACTION_OPTIONS.map((o) => `<option value="${o.value}" ${b.action === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </label>
        ${this._topBarTargetField(b, i)}
        <div>
          <button class="btn secondary" data-action="toggle-topbar-position" data-index="${i}">
            ${b.position ? '📍 Đang đặt vị trí riêng — bấm để bỏ (dùng vị trí mặc định góc trên-phải)' : '📍 Đặt vị trí riêng trong ảnh (kéo tự do)'}
          </button>
          ${b.position ? `<div class="hint">Vị trí hiện tại: x=${b.position.x}%, y=${b.position.y}% — vào "Chỉnh vị trí nhãn / điểm neo / cổng" để kéo.</div>` : ''}
        </div>
      </div>
    `;
  }

  _gateTargetField(gate) {
    if (gate.control_mode === 'switches') {
      return `
        <div class="hint">Dùng khi cổng không có 1 entity cover duy nhất mà chỉ có switch bấm-là-chạy (ví dụ ESP kích trực tiếp vào chân OP/CL/STP của board điều khiển cổng). Mở/Đóng vẫn phải VUỐT (như chế độ cover) để tránh chạm nhầm; Dừng thì bấm thường. Nếu khai báo thêm "Entity trạng thái" bên dưới, hướng vuốt sẽ tự theo trạng thái hiện tại (giống cover); nếu không, thumb bắt đầu ở giữa — vuốt trái để mở, vuốt phải để đóng.</div>
        <label>Switch Mở
          <ha-entity-picker data-field="gate.open_entity" data-domains="switch"></ha-entity-picker>
        </label>
        <label>Switch Dừng
          <ha-entity-picker data-field="gate.stop_entity" data-domains="switch"></ha-entity-picker>
        </label>
        <label style="display:flex; flex-direction:row; align-items:center; gap:6px;">
          <input type="checkbox" data-field="gate.show_stop_button" ${gate.show_stop_button === false ? '' : 'checked'} />
          <span>Hiện nút Dừng nhỏ cạnh thanh vuốt (bỏ tick để ẩn hẳn, ví dụ nếu bạn thấy không cần dùng tới)</span>
        </label>
        <label>Switch Đóng
          <ha-entity-picker data-field="gate.close_entity" data-domains="switch"></ha-entity-picker>
        </label>
        <label>Entity trạng thái (tuỳ chọn — hiện dòng "Đang mở/Đang khoá" nếu có, ví dụ binary_sensor lấy từ công tắc hành trình)
          <ha-entity-picker data-field="gate.state_entity" data-domains="binary_sensor,cover"></ha-entity-picker>
        </label>
        <div class="row">
          <label>Nhãn nút mở
            <input type="text" data-field="gate.open_label" value="${escapeHtml(gate.open_label || '')}" placeholder="Mở" />
          </label>
          <label>Nhãn nút đóng
            <input type="text" data-field="gate.close_label" value="${escapeHtml(gate.close_label || '')}" placeholder="Đóng" />
          </label>
        </div>
      `;
    }
    return `
      <label>Entity cổng (cover)
        <ha-entity-picker data-field="gate.entity" data-domains="cover"></ha-entity-picker>
      </label>
      <div class="row">
        <label>Nhãn nút mở
          <input type="text" data-field="gate.open_label" value="${escapeHtml(gate.open_label || '')}" placeholder="Mở cổng" />
        </label>
        <label>Nhãn nút đóng
          <input type="text" data-field="gate.close_label" value="${escapeHtml(gate.close_label || '')}" placeholder="Đóng cổng" />
        </label>
      </div>
    `;
  }

  _topBarTargetField(b, i) {
    switch (b.action) {
      case 'navigate':
        return `<label>Đường dẫn trang (navigation_path)
          <input type="text" data-field="top_bar_buttons.${i}.navigation_path" value="${escapeHtml(b.navigation_path || '')}" placeholder="/lovelace/security" />
        </label>`;
      case 'more-info':
      case 'toggle':
        return `<label>Entity
          <input type="text" data-field="top_bar_buttons.${i}.entity" value="${escapeHtml(b.entity || '')}" placeholder="alarm_control_panel.home" />
        </label>`;
      case 'camera':
        // Giữ tương thích ngược cho config cũ dùng action: camera
        return `<label>Entity camera (camera.xxx)
          <ha-entity-picker data-field="top_bar_buttons.${i}.entity" data-domains="camera"></ha-entity-picker>
        </label>`;
      case 'popup':
        return this._popupTargetField(b, i);
      case 'call-service':
        return `<label>Service (domain.service)
          <input type="text" data-field="top_bar_buttons.${i}.service" value="${escapeHtml(b.service || '')}" placeholder="script.turn_on" />
        </label>
        <label>Entity mục tiêu (tuỳ chọn)
          <input type="text" data-field="top_bar_buttons.${i}.entity" value="${escapeHtml(b.entity || '')}" />
        </label>`;
      case 'url':
        return `<label>URL
          <input type="text" data-field="top_bar_buttons.${i}.url" value="${escapeHtml(b.url || '')}" placeholder="https://..." />
        </label>`;
      default:
        return '';
    }
  }

  _popupTargetField(b, i) {
    const popupType = b.popup_type || 'camera';
    const sub = popupType === 'content'
      ? `
        <label>Tiêu đề popup
          <input type="text" data-field="top_bar_buttons.${i}.popup_title" value="${escapeHtml(b.popup_title || '')}" placeholder="Trợ giúp nhanh" />
        </label>
        <label>Nội dung popup
          <textarea data-field="top_bar_buttons.${i}.popup_content" rows="4" placeholder="Nội dung hiển thị trong popup...">${escapeHtml(b.popup_content || '')}</textarea>
        </label>
        <label>Ảnh minh hoạ (tuỳ chọn, URL)
          <input type="text" data-field="top_bar_buttons.${i}.popup_image" value="${escapeHtml(b.popup_image || '')}" placeholder="/local/floorplan/huong-dan.png" />
        </label>`
      : `<label>Entity camera (camera.xxx)
          <ha-entity-picker data-field="top_bar_buttons.${i}.entity" data-domains="camera"></ha-entity-picker>
        </label>`;
    return `
      <label>Loại popup
        <select data-field="top_bar_buttons.${i}.popup_type">
          <option value="camera" ${popupType === 'camera' ? 'selected' : ''}>Khung camera (live view, ví dụ chuông cửa)</option>
          <option value="content" ${popupType === 'content' ? 'selected' : ''}>Nội dung tuỳ chỉnh (tiêu đề/văn bản/ảnh)</option>
        </select>
      </label>
      ${sub}
    `;
  }

  _sceneEditorTemplate(s, i) {
    const entities = toArray(s.entity);
    const chips = entities.length
      ? entities.map((e, ei) => `
          <div class="chip">
            <span>${escapeHtml(e)}</span>
            <button class="chip-remove" data-action="remove-scene-entity" data-index="${i}" data-entity-index="${ei}" title="Xoá">✕</button>
          </div>`).join('')
      : '<div class="hint">Chưa chọn entity nào — tìm & thêm ở ô bên dưới.</div>';
    return `
      <div class="card-block">
        <div class="card-block-head">
          <strong>${escapeHtml(s.label || 'Kịch bản #' + (i + 1))}</strong>
          <button class="icon-btn" data-action="remove-scene" data-index="${i}" title="Xoá">✕</button>
        </div>
        <div class="row">
          <label>Icon (mdi:...)
            <ha-icon-picker data-field="scenes.${i}.icon"></ha-icon-picker>
          </label>
          <label>Nhãn
            <input type="text" data-field="scenes.${i}.label" value="${escapeHtml(s.label || '')}" />
          </label>
        </div>
        <label>Entity (scene / script / automation — chọn 1 hoặc nhiều)</label>
        <div class="chip-list">${chips}</div>
        <ha-entity-picker data-add-to="scenes.${i}.entity" data-domains="scene,script,automation" placeholder="🔍 Tìm entity để thêm..."></ha-entity-picker>
        <div class="hint">Nhiều automation trong 1 nút: bấm sẽ BẬT hết nếu đang có cái tắt, hoặc TẮT hết nếu tất cả đang bật — icon sáng khi TẤT CẢ automation trong danh sách đang bật.</div>
      </div>
    `;
  }

  _statusEditorTemplate(s, i) {
    return `
      <div class="card-block">
        <div class="card-block-head">
          <strong>${escapeHtml(s.label || 'Ô #' + (i + 1))}</strong>
          <button class="icon-btn" data-action="remove-status" data-index="${i}" title="Xoá">✕</button>
        </div>
        <div class="row">
          <label>Icon (mdi:...)
            <ha-icon-picker data-field="status_bar.${i}.icon"></ha-icon-picker>
          </label>
          <label>Nhãn
            <input type="text" data-field="status_bar.${i}.label" value="${escapeHtml(s.label || '')}" />
          </label>
        </div>
        <div class="row">
          <label>Entity
            <ha-entity-picker data-field="status_bar.${i}.entity"></ha-entity-picker>
          </label>
          <label>Đơn vị hiển thị
            <input type="text" data-field="status_bar.${i}.unit" value="${escapeHtml(s.unit || '')}" placeholder="°C" />
          </label>
        </div>
      </div>
    `;
  }

  /* -------------------------- Binding & events -------------------------- */

  _bindFormEvents() {
    const root = this.shadowRoot;

    // text / textarea / select fields -> update on change (blur) để tránh mất focus khi gõ
    root.querySelectorAll('[data-field]').forEach((el) => {
      if (el.tagName === 'HA-ENTITY-PICKER' || el.tagName === 'HA-ICON-PICKER') return; // xử lý riêng bên dưới
      if (el.type === 'checkbox') {
        el.addEventListener('change', () => this._onFieldChange(el.dataset.field, el.checked));
        return;
      }
      const evt = el.tagName === 'SELECT' ? 'change' : 'change';
      el.addEventListener(evt, () => this._onFieldChange(el.dataset.field, el.value));
    });

    // ha-entity-picker (field mode: gán trực tiếp 1 entity vào field) — set
    // hass + value, lắng nghe value-changed
    root.querySelectorAll('ha-entity-picker[data-field]').forEach((el) => {
      el.hass = this._hass;
      const domains = el.dataset.domains ? el.dataset.domains.split(',') : undefined;
      if (domains) el.includeDomains = domains;
      el.value = this._getByPath(el.dataset.field) || '';
      el.addEventListener('value-changed', (ev) => {
        this._onFieldChange(el.dataset.field, ev.detail.value);
      });
    });

    // ha-entity-picker (add mode: dùng để TÌM & THÊM 1 entity vào một danh
    // sách — vd scenes[].entity có thể chứa nhiều automation/script/scene).
    // Sau khi chọn xong, tự xoá trắng ô để người dùng tìm tiếp entity khác
    // thay vì phải mở lại; entity trùng thì bỏ qua, không thêm lặp.
    root.querySelectorAll('ha-entity-picker[data-add-to]').forEach((el) => {
      el.hass = this._hass;
      const domains = el.dataset.domains ? el.dataset.domains.split(',') : undefined;
      if (domains) el.includeDomains = domains;
      el.value = '';
      el.addEventListener('value-changed', (ev) => {
        const value = ev.detail.value;
        if (!value) return;
        const path = el.dataset.addTo;
        const current = toArray(this._getByPath(path));
        if (!current.includes(value)) current.push(value);
        this._onFieldChange(path, current);
        el.value = '';
      });
    });

    // ha-icon-picker: cho phép tìm kiếm icon mdi trực quan thay vì gõ tay chuỗi "mdi:..."
    root.querySelectorAll('ha-icon-picker').forEach((el) => {
      el.hass = this._hass;
      el.value = this._getByPath(el.dataset.field) || '';
      el.addEventListener('value-changed', (ev) => {
        this._onFieldChange(el.dataset.field, ev.detail.value);
      });
    });

    root.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => this._onAction(el.dataset.action, el.dataset.index, el.dataset.entityIndex));
    });
  }

  _getByPath(path) {
    const parts = path.split('.');
    let obj = this._config;
    for (const p of parts) {
      if (obj === undefined || obj === null) return undefined;
      obj = obj[p];
    }
    return obj;
  }

  _onFieldChange(path, rawValue) {
    const parts = path.split('.');
    const last = parts.pop();
    this._update((cfg) => {
      let obj = cfg;
      parts.forEach((p, i) => {
        if (obj[p] === undefined) {
          // Quyết định tạo mảng hay object dựa trên segment KẾ TIẾP (chỉ số tiếp
          // theo là số thì bản thân p phải là 1 mảng để chứa chỉ số đó).
          const nextSeg = i + 1 < parts.length ? parts[i + 1] : last;
          obj[p] = /^\d+$/.test(nextSeg) ? [] : {};
        }
        obj = obj[p];
      });
      if (Array.isArray(rawValue)) {
        obj[last] = rawValue;
      } else if (last === 'light_entities' || (last === 'entity' && parts[0] === 'scenes')) {
        obj[last] = rawValue.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      } else {
        obj[last] = rawValue;
      }
    });
  }

  _onAction(action, indexStr, entityIndexStr) {
    const index = indexStr !== undefined ? Number(indexStr) : undefined;
    if (action === 'open-position-editor') {
      this._positionEditorOpen = true;
      this._render();
      return;
    }
    if (action === 'add-room') {
      this._update((cfg) => {
        const n = cfg.rooms.length + 1;
        cfg.rooms.push({
          id: `room_${Date.now()}`,
          name: `Phòng mới ${n}`,
          temp_entity: '', humidity_entity: '', light_entities: [],
          label_position: { x: 50, y: 50 }, anchor_position: { x: 50, y: 60 },
        });
      });
    } else if (action === 'remove-room') {
      this._update((cfg) => cfg.rooms.splice(index, 1));
    } else if (action === 'add-topbar') {
      this._update((cfg) => cfg.top_bar_buttons.push({ icon: 'mdi:help-circle', label: 'Nút mới', action: 'navigate', navigation_path: '' }));
    } else if (action === 'remove-topbar') {
      this._update((cfg) => cfg.top_bar_buttons.splice(index, 1));
    } else if (action === 'add-scene') {
      this._update((cfg) => cfg.scenes.push({ icon: 'mdi:play', label: 'Kịch bản mới', entity: '' }));
    } else if (action === 'remove-scene') {
      this._update((cfg) => cfg.scenes.splice(index, 1));
    } else if (action === 'remove-scene-entity') {
      const entityIndex = Number(entityIndexStr);
      this._update((cfg) => {
        const list = toArray(cfg.scenes[index].entity);
        list.splice(entityIndex, 1);
        cfg.scenes[index].entity = list;
      });
    } else if (action === 'add-status') {
      this._update((cfg) => cfg.status_bar.push({ icon: 'mdi:information', label: 'Trạng thái mới', entity: '', unit: '' }));
    } else if (action === 'remove-status') {
      this._update((cfg) => cfg.status_bar.splice(index, 1));
    } else if (action === 'add-media-bar-button') {
      this._update((cfg) => {
        if (!cfg.media_bar) cfg.media_bar = { icon: 'mdi:play-circle-outline', buttons: [] };
        if (!cfg.media_bar.buttons) cfg.media_bar.buttons = [];
        cfg.media_bar.buttons.push({ icon: 'mdi:apps', label: 'Nút mới', popup: null });
      });
    } else if (action === 'remove-media-bar-button') {
      this._update((cfg) => cfg.media_bar.buttons.splice(index, 1));
    } else if (action === 'close-position-editor') {
      this._positionEditorOpen = false;
      this._render();
    } else if (action === 'toggle-topbar-position') {
      let justEnabled = false;
      this._update((cfg) => {
        const b = cfg.top_bar_buttons[index];
        if (b.position) {
          delete b.position;
          delete b.anchor_position;
        } else {
          b.position = { x: 50, y: 10 };
          b.anchor_position = { x: 50, y: 18 };
          justEnabled = true;
        }
      });
      if (justEnabled) {
        this._positionEditorOpen = true;
        this._render();
      }
    } else if (action === 'add-robot-cal') {
      this._update((cfg) => {
        if (!cfg.robot) cfg.robot = {};
        if (!cfg.robot.calibration) cfg.robot.calibration = [];
        const n = cfg.robot.calibration.length;
        // Rải vị trí mặc định theo lưới 3 cột để các điểm mới không đè lên
        // nhau khi mở "📍 Chỉnh vị trí" — người dùng sẽ kéo lại cho đúng sau.
        cfg.robot.calibration.push({
          room: '',
          image: { x: 20 + (n % 3) * 30, y: 20 + Math.floor(n / 3) * 25 },
        });
      });
    } else if (action === 'remove-robot-cal') {
      this._update((cfg) => cfg.robot.calibration.splice(index, 1));
    } else if (action === 'capture-robot-cal') {
      const r = this._config.robot;
      if (!r || !r.entity || !this._hass || !this._hass.states[r.entity]) {
        alert('Chưa chọn camera bản đồ, hoặc entity chưa có dữ liệu. Hãy chọn entity trước.');
        return;
      }
      const attrName = r.position_attribute || 'robot_position';
      const raw = this._hass.states[r.entity].attributes[attrName];
      let rx;
      let ry;
      if (Array.isArray(raw)) { [rx, ry] = raw; } else if (raw && typeof raw === 'object') { rx = raw.x; ry = raw.y; }
      if (!Number.isFinite(Number(rx)) || !Number.isFinite(Number(ry))) {
        alert(`Không đọc được toạ độ từ thuộc tính "${attrName}". Kiểm tra lại tên thuộc tính trong Developer Tools > States của entity này.`);
        return;
      }
      this._update((cfg) => {
        if (!cfg.robot.calibration) cfg.robot.calibration = [];
        if (!cfg.robot.calibration[index]) cfg.robot.calibration[index] = {};
        cfg.robot.calibration[index].robot = { x: Number(rx), y: Number(ry) };
        if (!cfg.robot.calibration[index].image) {
          const n = index;
          cfg.robot.calibration[index].image = { x: 20 + (n % 3) * 30, y: 20 + Math.floor(n / 3) * 25 };
        }
      });
    }
  }

  /* ------------------------- Position drag overlay ------------------------- */

  _renderPositionEditor() {
    const cfg = this._config;
    const rooms = cfg.rooms || [];
    const aspect = String(cfg.aspect_ratio || '16/9').replace(':', '/');

    const dots = [];
    rooms.forEach((r, i) => {
      const lp = r.label_position || { x: 50, y: 50 };
      const ap = r.anchor_position || { x: 50, y: 60 };
      dots.push({ kind: 'label', roomIndex: i, x: lp.x, y: lp.y, color: '#4fc3f7', title: r.name || r.id });
      dots.push({ kind: 'anchor', roomIndex: i, x: ap.x, y: ap.y, color: '#ffd166', title: `${r.name || r.id} (điểm neo)` });
    });
    const gateHasControlForDots = cfg.gate && (cfg.gate.control_mode === 'switches'
      ? (cfg.gate.open_entity || cfg.gate.close_entity || cfg.gate.stop_entity)
      : cfg.gate.entity);
    if (gateHasControlForDots) {
      const gp = cfg.gate.position || { x: 50, y: 70 };
      const gap = cfg.gate.anchor_position || { x: gp.x, y: Math.max(0, gp.y - 8) };
      dots.push({ kind: 'gate', x: gp.x, y: gp.y, color: '#8bd17c', title: cfg.gate.name || 'Cổng chính' });
      dots.push({ kind: 'gate-anchor', x: gap.x, y: gap.y, color: '#ffd166', title: `${cfg.gate.name || 'Cổng chính'} (điểm neo)` });
    }
    (cfg.top_bar_buttons || []).forEach((b, i) => {
      // Chỉ hiện chấm kéo cho nút đã bật chế độ "vị trí riêng" (có b.position);
      // nút chưa bật vẫn nằm trong nhóm mặc định góc trên-phải, không cần chỉnh.
      if (!b.position) return;
      const ap = b.anchor_position || { x: b.position.x, y: Math.max(0, b.position.y - 8) };
      dots.push({ kind: 'topbar', topbarIndex: i, x: b.position.x, y: b.position.y, color: '#ef7bd1', title: b.label || `Nút ${i + 1}` });
      dots.push({ kind: 'topbar-anchor', topbarIndex: i, x: ap.x, y: ap.y, color: '#ffd166', title: `${b.label || `Nút ${i + 1}`} (điểm neo)` });
    });
    (((cfg.robot && cfg.robot.calibration) || [])).forEach((c, i) => {
      // Chỉ cần đã có toạ độ robot (gõ tay hoặc bấm "Lấy toạ độ hiện tại") là hiện
      // chấm để kéo; nếu chưa có vị trí trên ảnh thì dùng vị trí mặc định ban đầu.
      if (!c || !c.robot) return;
      const img = c.image || (i === 0 ? { x: 35, y: 50 } : { x: 65, y: 50 });
      const label = `Robot — điểm hiệu chỉnh ${i + 1}${c.room ? ` (${c.room})` : ''}`;
      dots.push({ kind: 'robot-cal', calIndex: i, x: img.x, y: img.y, color: '#c084fc', title: label });
    });

    this.shadowRoot.innerHTML = `
      <style>${EDITOR_STYLE}</style>
      <div class="editor">
        <div class="pos-toolbar">
          <div>Kéo các chấm để chỉnh vị trí: <span class="legend"><i style="background:#4fc3f7"></i>Nhãn phòng</span>
            <span class="legend"><i style="background:#ffd166"></i>Điểm neo</span>
            <span class="legend"><i style="background:#8bd17c"></i>Cổng</span>
            <span class="legend"><i style="background:#ef7bd1"></i>Nút top-bar</span>
            <span class="legend"><i style="background:#c084fc"></i>Hiệu chỉnh robot</span>
          </div>
          <button class="btn secondary" data-action="close-position-editor">✕ Đóng, quay lại form</button>
        </div>
        <div class="pos-wrapper" style="aspect-ratio:${aspect}">
          ${cfg.background_image ? `<img class="pos-bg" src="${escapeHtml(cfg.background_image)}" alt="floorplan" />` : '<div class="empty-state">Chưa có ảnh nền — hãy nhập background_image trước.</div>'}
          ${dots.map((d, i) => `
            <div class="drag-dot" data-dot-index="${i}" style="left:${d.x}%; top:${d.y}%; background:${d.color};" title="${escapeHtml(d.title)}">
              <span class="drag-label">${escapeHtml(d.title)}</span>
            </div>`).join('')}
        </div>
      </div>
    `;

    this._dots = dots;
    const wrapper = this.shadowRoot.querySelector('.pos-wrapper');
    this.shadowRoot.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => this._onAction(el.dataset.action));
    });
    this.shadowRoot.querySelectorAll('.drag-dot').forEach((dotEl) => {
      dotEl.addEventListener('pointerdown', (e) => this._startDrag(e, dotEl, wrapper));
    });
  }

  _startDrag(e, dotEl, wrapper) {
    e.preventDefault();
    const index = Number(dotEl.dataset.dotIndex);
    dotEl.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const rect = wrapper.getBoundingClientRect();
      let x = ((ev.clientX - rect.left) / rect.width) * 100;
      let y = ((ev.clientY - rect.top) / rect.height) * 100;
      x = Math.min(100, Math.max(0, x));
      y = Math.min(100, Math.max(0, y));
      dotEl.style.left = `${x}%`;
      dotEl.style.top = `${y}%`;
      this._dots[index].x = x;
      this._dots[index].y = y;
    };
    const up = () => {
      dotEl.removeEventListener('pointermove', move);
      dotEl.removeEventListener('pointerup', up);
      this._commitDotPosition(index);
    };
    dotEl.addEventListener('pointermove', move);
    dotEl.addEventListener('pointerup', up);
  }

  _commitDotPosition(index) {
    const d = this._dots[index];
    this._update((cfg) => {
      if (d.kind === 'label') cfg.rooms[d.roomIndex].label_position = { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 };
      else if (d.kind === 'anchor') cfg.rooms[d.roomIndex].anchor_position = { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 };
      else if (d.kind === 'gate') cfg.gate.position = { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 };
      else if (d.kind === 'gate-anchor') cfg.gate.anchor_position = { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 };
      else if (d.kind === 'topbar') cfg.top_bar_buttons[d.topbarIndex].position = { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 };
      else if (d.kind === 'topbar-anchor') cfg.top_bar_buttons[d.topbarIndex].anchor_position = { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 };
      else if (d.kind === 'robot-cal') cfg.robot.calibration[d.calIndex].image = { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 };
    });
    // sau khi commit, _update() gọi _render() -> vì _positionEditorOpen vẫn true nên overlay tự vẽ lại, giữ nguyên chế độ chỉnh vị trí
  }
}

const EDITOR_STYLE = `
  :host { display:block; }
  .editor { display:flex; flex-direction:column; gap:16px; padding:4px 0; color: var(--primary-text-color); }
  .credit { display:flex; align-items:center; gap:8px; padding:0 0 10px; margin-bottom:2px;
    font-size:12px; font-weight:600; color: var(--primary-color, #03a9f4);
    border-bottom:1px solid var(--divider-color, #444); }
  .credit-sub { color: var(--secondary-text-color, rgba(255,255,255,0.6)); font-weight:400; }
  .credit-links { display:flex; gap:8px; margin:-6px 0 4px; }
  .credit-link { display:flex; align-items:center; gap:6px; flex:1; padding:7px 10px; border-radius:10px;
    text-decoration:none; cursor:pointer; border:1px solid rgba(255,255,255,0.08);
    box-shadow:0 2px 8px rgba(0,0,0,0.3); transition:transform .15s, box-shadow .15s; }
  .credit-link:hover { transform:translateY(-1px); }
  .credit-link.tiktok { background:linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(30,20,40,0.92) 100%); }
  .credit-link.tiktok:hover { box-shadow:0 4px 16px rgba(0,0,0,0.4); }
  .credit-link.paypal { background:linear-gradient(135deg, rgba(0,68,153,0.9) 0%, rgba(0,36,100,0.95) 100%); }
  .credit-link.paypal:hover { box-shadow:0 4px 16px rgba(0,68,153,0.5); }
  .credit-link-title { font-size:11px; font-weight:700; color:#fff; line-height:1.3; white-space:nowrap; }
  .credit-link-sub { font-size:9.5px; color:rgba(255,255,255,0.55); line-height:1.3; white-space:nowrap; }
  .section { border:1px solid var(--divider-color, #444); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:8px; }
  .section-title { font-weight:600; font-size:13px; opacity:.85; margin-bottom:4px; }
  label { display:flex; flex-direction:column; gap:4px; font-size:12px; opacity:.85; flex:1; }
  input, textarea, select { font: inherit; padding:8px; border-radius:6px; border:1px solid var(--divider-color, #555);
    background: var(--card-background-color, #1c1c1c); color: var(--primary-text-color); }
  .row { display:flex; gap:10px; }
  .row > label { min-width:0; }
  .btn { padding:8px 12px; border-radius:8px; border:1px solid var(--divider-color, #555); background:transparent;
    color: var(--primary-text-color); cursor:pointer; font-size:12px; align-self:flex-start; }
  .btn.secondary { background: var(--primary-color, #03a9f4); color:#fff; border:none; }
  .card-block { border:1px dashed var(--divider-color, #555); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:8px; }
  .card-block-head { display:flex; justify-content:space-between; align-items:center; }
  .icon-btn { background:transparent; border:none; color:#e57373; cursor:pointer; font-size:14px; }
  .hint { font-size:11px; opacity:.6; }
  .chip-list { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { display:flex; align-items:center; gap:6px; background: var(--secondary-background-color, rgba(255,255,255,0.08));
    border:1px solid var(--divider-color, #555); border-radius:14px; padding:4px 6px 4px 10px; font-size:11px; }
  .chip-remove { background:transparent; border:none; color:#e57373; cursor:pointer; font-size:11px; padding:2px; line-height:1; }
  .pos-toolbar { display:flex; justify-content:space-between; align-items:center; font-size:12px; gap:10px; flex-wrap:wrap; }
  .legend { display:inline-flex; align-items:center; gap:4px; margin-left:10px; }
  .legend i { width:10px; height:10px; border-radius:50%; display:inline-block; }
  .pos-wrapper { position:relative; width:100%; background:#000; border-radius:10px; overflow:hidden; }
  .pos-bg { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .drag-dot { position:absolute; width:16px; height:16px; border-radius:50%; transform:translate(-50%,-50%);
    border:2px solid #fff; cursor:grab; touch-action:none; box-shadow:0 0 6px rgba(0,0,0,.6); }
  .drag-dot:active { cursor:grabbing; }
  .drag-label { position:absolute; top:20px; left:50%; transform:translateX(-50%); font-size:10px; color:#fff;
    background:rgba(0,0,0,.6); padding:2px 5px; border-radius:4px; white-space:nowrap; pointer-events:none; }
`;

if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, FloorplanCardEditor);
}
if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, FloorplanCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: 'Floorplan Card',
    description: 'Sơ đồ mặt bằng nhà thông minh: nhãn phòng, đường neo, cổng, nút popup (camera / nội dung tuỳ chỉnh), kịch bản nhanh, thanh trạng thái.',
    preview: true,
  });
}
