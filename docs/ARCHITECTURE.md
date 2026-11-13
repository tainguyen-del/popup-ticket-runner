# Kiến trúc Popup Ticket Runner

`src/run.js` là bộ điều phối workflow. Logic thuần và các quy tắc nghiệp vụ phải nằm trong module theo miền để có thể sửa và kiểm thử độc lập.

## Module hiện có

- `src/ticket-parser.js`: đọc Website ID, hành động create/replace/remove và lịch popup từ nội dung ticket.
- `src/semantic-ticket.js`: Gemini text/Vision; kết quả luôn được kiểm tra lại cục bộ trước khi dùng.
- `src/attachment-plan.js`: chọn luồng không ảnh, một ảnh, nhiều poster hoặc ảnh tham chiếu để gỡ popup.
- `src/cms/project-selector.js`: chọn đúng project, ưu tiên site có custom domain khi trùng Website ID.
- `src/cms/plugin-policy.js`: đọc version plugin và quyết định khi nào bắt buộc tạo Announcement section mới.
- `src/cms/popup-verification.js`: chuẩn hóa URL ảnh, kiểm tra ngày và xác minh poster sau khi CMS đổi thứ tự card.
- `src/cms/popup-order-policy.js`: lập kế hoạch/xác minh vị trí first/last mà ticket yêu cầu, đồng thời bảo toàn thứ tự các popup khác.
- `src/cms/popup-image-policy.js`: đối chiếu SHA-256 và định danh filename an toàn để chặn poster trùng trước khi sửa CMS.
- `src/browser-session.js` và `src/session-manager.js`: phiên Chrome riêng của app và quy trình đăng nhập.
- `src/server.js`: API local, trạng thái job và báo cáo an toàn cho giao diện.

## Quy tắc phát triển

1. Parser và policy không thao tác trình duyệt; mọi case mới phải có unit test.
2. Gemini chỉ đề xuất dữ liệu. Attachment index, ngày và ảnh phải được kiểm tra lại trước khi sửa CMS.
3. Không dùng vị trí card làm định danh lâu dài vì NewZen có thể prepend/append item. Xác minh bằng URL ảnh đã chuẩn hóa và lịch popup.
4. Mọi ảnh cần upload phải được tải và kiểm tra cục bộ trước khi mở luồng ghi CMS.
5. Build chỉ được phép chạy khi mọi poster trong kế hoạch đã tồn tại đúng một lần, không còn item trống và lịch khớp ticket.
6. Nếu ticket yêu cầu vị trí, Build chỉ chạy sau khi CMS serialize đúng thứ tự đó; nếu ảnh đã tồn tại hoặc ảnh cần gỡ không có bản khớp duy nhất, workflow phải dừng với lỗi riêng.

## Phần tiếp tục tách

`run.js` vẫn còn các thao tác Playwright. Các nhóm tiếp theo nên được tách theo thứ tự:

1. `src/crm/ticket-reader.js` và `src/crm/attachments.js`.
2. `src/cms/plugin.js` và `src/cms/announcement-section.js`.
3. `src/cms/popup-calendar.js`, `src/cms/popup-items.js`, `src/cms/popup-migration.js`.
4. `src/cms/timezone.js` và `src/cms/build.js`.

Mỗi lần tách chỉ di chuyển một nhóm trách nhiệm, giữ API tương thích và chạy toàn bộ test trước khi tiếp tục.
