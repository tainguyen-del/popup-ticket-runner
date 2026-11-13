# Popup Ticket Runner

## Cách dùng hiện tại

Chạy trực tiếp `Popup Ticket Runner Final.exe`; không cần cài đặt, Node.js hay PowerShell.

Ở lần dùng đầu tiên trên mỗi máy, nhập Gemini API key trong thẻ **Gemini cho ticket và poster**. Bản portable mã hóa key bằng kho bảo mật Windows, chỉ lưu bản mã hóa trong AppData của người dùng và không đưa key vào log hoặc báo cáo. Không chia sẻ thư mục AppData hay Chrome profile; chỉ gửi file portable.

Lần đầu, app mở Chrome riêng để đăng nhập CRM và NewZenSite. Những lần sau app tự khôi phục phiên đã lưu; chỉ yêu cầu đăng nhập lại khi CRM hoặc CMS hết phiên. Dán link ticket vào app để chạy workflow.

Tool chỉ đọc **ngày** bắt đầu/kết thúc popup. Nó nhận các dạng ghi phổ biến như `từ ... đến ...`, `from ... through ...`, `start/end`, `expiry/remove`; một khoảng qua năm mới như `11/19/2026 → 01/02/2026` được hiểu là kết thúc `2027-01-02`. Nếu lịch mâu thuẫn, app dừng trước khi sửa CMS.

> Các hướng dẫn dòng lệnh bên dưới chỉ còn là tài liệu kỹ thuật cũ, không cần dùng khi chạy app portable.

## Luồng hiện tại

Giao diện local (`npm run ui`) chạy toàn bộ luồng ngay khi nhận link ticket: tải poster về máy, cài/update/bật Announcement khi cần, thêm `Annoucement Popup`, upload poster, lưu settings, rồi Build/publish website. Tool **không** dùng trạng thái ticket CRM làm điều kiện.

Timezone được đọc lần lượt từ `data/setting.json`, `data/settings.json`, rồi `data/footer.json`. Ví dụ `Enumclaw, WA 98022` được map thành `America/Los_Angeles` và chọn nhãn CMS `Los Angeles (UTC-08:00)`. Nếu không suy ra được timezone an toàn, write mode sẽ dừng.

Tool tự nhận ngày hết hạn dạng ISO, MM/DD/YYYY hoặc tên tháng tiếng Anh trong ticket; nếu ngày mơ hồ, nó dừng trước khi sửa CMS thay vì đặt sai ngày. Dòng lệnh vẫn có thể ghi đè bằng `--apply --expiry YYYY-MM-DD`.

MVP an toàn cho CRM → NewZenSite. Nhập link ticket; tool đọc ticket, nhận diện Website ID, mở Organization `fastboy`, rồi tìm project tương ứng.

Mặc định dòng lệnh chỉ scan, không tải poster, cài plugin, upload ảnh, sửa popup hay publish. Giao diện local tự chạy write mode và Build/publish sau mỗi lần nhập link. Kết quả nằm trong `runs/<thời-gian>/plan.json`, kèm ảnh chụp và text ticket.

## Giao diện local

Mở giao diện nhập link ticket và theo dõi từng bước xử lý:

Double-click `Start Local Test.cmd` in the project folder. It starts the
server from your own Windows desktop and opens the local page automatically.
This matters: a server started by a background service (including an automated
agent) cannot show its Chrome login window on your desktop.
On the first launch, the local page automatically opens a separate Chrome
window with exactly two tabs: Fastboy CRM Technical and NewZenSite CMS. Sign
in once in those tabs, return to the local page, and press the verification
button. A saved valid session does not open the tabs again on later launches.

Or start it manually from a terminal that you opened yourself:

```powershell
cd C:\tools\popup-ticket-runner
npm run ui
```

Sau đó mở `http://127.0.0.1:4317`. Server chỉ chạy trên máy cục bộ (`127.0.0.1`), chỉ chấp nhận link `crm.fastboy.dev`, và chỉ chạy một ticket mỗi lần để bảo vệ Chrome profile.

Giao diện báo rõ trạng thái Announcement plugin trong khi chạy. Mỗi lần nhập link sẽ tự chạy write mode: tool hover thumbnail attachment, click `Download file` (hoặc `Download all attachments` dự phòng), kiểm tra file ảnh cục bộ, rồi mới tiếp tục. Tool không dùng `index.yml` để xác nhận section vì CMS cập nhật file này khi Build. Write mode có thể:

1. cài, update hoặc bật Announcement plugin khi cần;
2. tạo `Annoucement Popup` chỉ khi `index.yml` chưa có section này;
3. thêm popup block mới, upload poster đã tải/xác minh vào block đó, đặt timezone và lưu settings;
4. Build website, chờ tín hiệu thành công từ CMS, rồi log Live URL của website.

Giao diện chỉ báo **Popup thành công** khi CMS hiển thị tiến trình Build đạt `100%` và có thông báo thành công. Nếu không thấy đủ hai tín hiệu này, tool báo `build-unconfirmed`, không báo thành công sai.

## Cài đặt

Yêu cầu Node.js 20+ và Google Chrome:

```powershell
cd C:\tools\popup-ticket-runner
npm install
```

## Chạy

Trước lần chạy đầu, đăng nhập một lần vào Chrome profile riêng của tool. Phiên này được lưu tách biệt, không xung đột Chrome chính:

```powershell
node .\src\setup.js
```

Trong cửa sổ Chrome vừa mở, đăng nhập CRM và NewZenSite. Khi xong, quay lại PowerShell và nhấn `Enter`.

Sau đó chạy ticket:

```powershell
node .\src\run.js --ticket-url "https://crm.fastboy.dev/tickets/detail/1579195" --headed
```

Giao diện local tự thực hiện write mode và Build/publish. Với dòng lệnh, thêm cả `--apply --build`.

```powershell
node .\src\run.js --ticket-url "https://crm.fastboy.dev/tickets/detail/1579195" --apply --build --headed
```

Nếu cần set expiry, thêm `--expiry YYYY-MM-DD`.

## Nếu ticket chưa trích xuất được Website ID

Có thể thử riêng bước CMS bằng ID đã biết, không cần sửa ticket:

```powershell
node .\src\run.js --ticket-url "https://crm.fastboy.dev/tickets/detail/1579195" --site-id 10001 --headed
```

Nếu `plan.json` có trạng thái `browser-offline`, hãy chạy lại `node .\src\setup.js` và bảo đảm bạn đã đăng nhập trong **Chrome của tool**. Trạng thái này không phải lỗi Website ID.

Nếu vẫn offline sau setup, chạy chẩn đoán chỉ-đọc rồi gửi lại tên file JSON:

```powershell
node .\src\diagnose.js
```
