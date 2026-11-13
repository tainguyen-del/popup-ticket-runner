@echo off
chcp 65001 >nul
echo Đang bật chế độ theo dõi lưu file...
node scripts/watch-push.js
pause
