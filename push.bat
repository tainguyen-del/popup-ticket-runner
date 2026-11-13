@echo off
chcp 65001 >nul
echo ===================================================
echo   Đang đẩy code lên GitHub và kích hoạt Build Release...
echo ===================================================
git add .
set /p msg="Nhập nội dung commit (hoặc nhấn Enter để mặc định): "
if "%msg%"=="" set msg=Update code
git commit -m "%msg%"
git push origin main
echo ===================================================
echo   Hoàn tất! GitHub Actions đang tự build bản .exe mới.
echo ===================================================
pause
