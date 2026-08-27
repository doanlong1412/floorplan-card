# Changelog

Tất cả thay đổi đáng chú ý của dự án này sẽ được ghi lại trong file này.

Định dạng dựa trên [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0] - 2026-08-27

### 🚀 Phát hành lần đầu

- 🏠 Sơ đồ mặt bằng với nhãn phòng theo toạ độ phần trăm, đường neo và chấm neo
- 🌡️ Gradient màu theo nhiệt độ giữa các phòng + ngưỡng nhấp nháy "nóng quá" có thể cấu hình
- 💡 Chip đèn phòng bật/tắt toàn bộ đèn trong phòng cùng lúc, kèm badge số đèn đang bật
- 🚪 Widget cổng với 2 chế độ điều khiển: 1 entity cover, hoặc 3 công tắc rời với thanh trượt trung tính tự bật lại giữa
- 🕹️ Nút popup top-bar — navigate, more-info, popup (camera/nội dung), toggle, call-service, url
- 🎬 Kịch bản bấm nhanh với hiệu ứng glow xoay viền khi đang hoạt động
- 📊 Chip thanh trạng thái có thể cấu hình
- 🤖 Chấm vị trí robot hút bụi qua phép biến đổi homography (4+ điểm hiệu chỉnh), hoạt động tốt trên sơ đồ phối cảnh/isometric
- 🧵 Vệt đường đi của robot tự mờ dần sau khi dọn xong
- 🎛️ Trình chỉnh sửa trực quan đầy đủ với công cụ chỉnh vị trí kéo-thả cho mọi phần tử
- 🛡️ Tự phục hồi khi render lỗi — tự thử lại sau lỗi tạm thời thay vì bị trắng
- ⚡ Cơ chế hash kiểu `shouldUpdate` — chỉ render lại khi entity được khai báo thực sự đổi trạng thái
