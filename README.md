# Project Manager

Ứng dụng web quản lý dự án full-stack xây dựng với **Express + MongoDB** và **React + Vite**. Phát triển từ một ứng dụng ghi chú cá nhân thành công cụ quản lý dự án hoàn chỉnh: bảng Kanban, chấm công, ngân sách, và các thuật toán lập lịch dựa trên lý thuyết quản lý dự án - đường găng CPM, biểu đồ Gantt, đường cong tải nhân lực, lập lịch ràng buộc nhân lực (serial method) và phân tích rút ngắn tiến độ (crashing).

> **Project III (IT4950)** — Đại học Bách khoa Hà Nội, Hoàng Hải Minh (20225362).

## Tính năng

**Dự án & cộng tác**
- Dự án với 5 vai trò thành viên: `owner`, `moderator`, `editor`, `reviewer`, `viewer` - ánh xạ xuống quyền write/comment/read trên từng task
- Bảng Kanban kéo thả (@dnd-kit), chế độ danh sách, bình luận task
- Subtask (tiến độ task cha tự tổng hợp) và phụ thuộc giữa các task với kiểm tra chu trình BFS, cảnh báo task bị chặn
- Xóa mềm + thùng rác/khôi phục, ghi audit log cho mọi thao tác ghi

**Thời gian & ngân sách**
- Chấm công theo giờ (time entry) với timesheet cá nhân theo tuần
- Đơn giá nhân công từng người, admin chỉnh tại trang `/admin/billing`; dashboard ngân sách với chi phí kế hoạch/thực tế
- Báo cáo liên dự án, xuất CSV

**Lập lịch & tối ưu (lý thuyết QLDA)**
- **Lịch CPM** - duyệt xuôi/ngược, ES/EF/LS/LF, total & free slack, đường găng
- **Biểu đồ Gantt** (frappe-gantt) với chế độ Earliest/Latest và Day/Week/Month; task găng tô đỏ
- **Đường cong tải nhân lực** với vùng đỏ vượt giới hạn nhân lực
- **Lịch ràng buộc nhân lực** - serial method dưới `maxHeadcount`, kèm banner độ trễ dự án
- **Phân tích crashing** - lát cắt chi phí nhỏ nhất trên các đường găng; bảng tổng hợp với phương án tối ưu được tô sáng

**Nền tảng**
- Xác thực JWT (bcrypt), quản lý ban, trang quản trị moderator/admin cấp hệ thống
- Giao diện sáng / tối / theo hệ thống

## Công nghệ

| Tầng     | Công nghệ |
|----------|-----------|
| Backend  | Node.js, Express 5, Mongoose 9 (MongoDB Atlas), JWT, bcrypt — CommonJS, JS thuần |
| Frontend | React 19, React Router 7, Vite 7, Axios, @dnd-kit, frappe-gantt, Recharts, react-toastify, CSS thuần |
| Deploy   | Firebase Hosting (frontend), Docker (backend) |

## Cấu trúc thư mục

```
backend/
  server.js              đọc .env, kiểm tra cấu hình, kết nối MongoDB rồi chạy src/app.js
  src/
    app.js               Express app: helmet, CORS, mount /api/auth, /api/notes, /api/projects,
                         /api/time-entries, /api/admin, middleware xử lý lỗi chung
    controller/          auth, note (task), taskLink (bình luận, subtask, phụ thuộc), project, timeEntry, admin
    middleware/          JWT auth + kiểm tra ban, requireRole, errorHandler (ghi log lỗi, trả 4xx/500)
    models/              User, Note (Task), Project, TimeEntry, AuditLog
    services/            thuật toán lập lịch thuần (không I/O): scheduler.js (CPM),
                         serialScheduler.js, crashing.js, scheduleTasks.js (chuẩn bị đầu vào) + unit test
    utils/               audit (writeAudit), access (phân quyền task), regex (escape tìm kiếm),
                         taskLifecycle (xóa/khôi phục task kèm subtask, liên kết, chấm công),
                         taskFields (kiểm tra dữ liệu task), taskRules (assignee, cha/con, phụ thuộc),
                         taskResponse (định dạng task trả về)
  scripts/               makeAdmin, backfillPersonalProjects, migrateSchema
frontend/
  src/
    pages/               Projects, ProjectDetail (Board|List|Timeline|Dashboard|Log|Settings),
                         ProjectOptimize, MyTime, Reports, AdminBilling, Login, Register
    components/          KanbanBoard, ProjectGantt, ResourceCurve, ProjectDashboard, ThemeButton,
                         LogoutButton, ...
    components/project/  từng tab của ProjectDetail (TaskListTab, TimelineTab, ProjectLogTab,
                         ProjectSettingsTab) và TaskModal
    services/            các wrapper Axios (api.js với JWT interceptor)
    hooks/               useTheme, useSchedule, useTaskEditor (trạng thái form task)
```

## Cài đặt và chạy

### Yêu cầu
- Node.js 22+ và một connection string MongoDB (ví dụ MongoDB Atlas)

### Backend

```bash
cd backend
npm install
```

Sao chép `backend/.env.example` thành `backend/.env` rồi điền giá trị:

```
MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>/<db>
JWT_SECRET=<your_secret>
PORT=5000
CORS_ORIGIN=http://localhost:5173
TRUST_PROXY=
```

Server sẽ dừng ngay nếu thiếu `MONGO_URI`, `JWT_SECRET` hoặc không kết nối được MongoDB. `CORS_ORIGIN` là danh sách URL frontend được phép gọi API (phân tách bằng dấu phẩy); khi để trống ở môi trường dev, mặc định cho phép `http://localhost:5173` và `http://localhost:4173`.

Chạy:

```bash
npm start          # http://localhost:5000
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

API base URL mặc định là `http://localhost:5000/api`; khi cần đổi, sao chép `frontend/.env.example` thành `frontend/.env` và sửa `VITE_API_URL`.

## Kiểm thử

Các thuật toán lập lịch có bộ unit test độc lập, không cần DB (dùng `assert` của Node):

```bash
cd backend
npm test
```

- `scheduler.test.js` - mạng CPM 8 công việc với đáp án biết trước (thời gian dự án 17, đường găng A→B→D→G→H, toàn bộ slack)
- `serialScheduler.test.js` - lịch ràng buộc nhân lực dưới giới hạn (11 → 15 đơn vị, trễ 4)
- `crashing.test.js` - bảng tổng hợp crashing và phương án tối ưu trên mạng có hai đường găng
- `scheduleTasks.test.js` - task cha bao trọn các subtask (không cộng thời lượng riêng), task bị hủy không chiếm thời gian hay nhân lực

Kiểm thử API (phân quyền, xóa/khôi phục, lưu trữ dự án, lập lịch) chạy trên MongoDB trong bộ nhớ, không đụng tới dữ liệu thật:

```bash
cd backend
npm run test:api   # lần đầu tải MongoDB server (~630 MB) vào ~/.cache/mongodb-binaries
```
- `access.test.js` - quy tắc phân quyền task theo vai trò trong dự án và escape từ khóa tìm kiếm

## Script tiện ích

Tất cả script mặc định chạy dry-run; thêm `--apply` để ghi thật.

```bash
node scripts/makeAdmin.js <email>            # cấp quyền admin
node scripts/backfillPersonalProjects.js     # gán task chưa có dự án vào dự án Personal (user tự có dự án Personal khi đăng ký/đăng nhập)
node scripts/migrateSchema.js                # backfill duration/timeUnit/actualStart-End (= npm run migrate)
```

## Các API endpoint chính

| Endpoint | Mô tả |
|----------|-------|
| `POST /api/auth/register`, `/login`, `GET /me` | Xác thực |
| `GET/POST /api/projects`, `.../members`, `.../budget-summary` | Dự án, thành viên, ngân sách |
| `GET/POST /api/notes`, `.../subtasks`, `.../dependencies` | Task, subtask, phụ thuộc |
| `GET /api/projects/:id/schedule` (`?constrained=true`) | Lịch CPM / serial method |
| `GET /api/projects/:id/resource-curve` | Đường cong tải nhân lực |
| `GET /api/projects/:id/crash-analysis` | Bảng tổng hợp crashing |
| `GET/POST /api/time-entries` | Chấm công |
| `/api/admin/...` | Quản lý user/role/ban, audit logs hệ thống |

Lỗi nghiệp vụ (chu trình phụ thuộc, thiếu cấu hình lập lịch) trả về `400` với thông báo rõ ràng.

## Triển khai

- **Frontend**: `npm run build`, deploy thư mục `dist/` bằng Firebase Hosting (`firebase.json` rewrite mọi route về `/index.html` cho SPA).
- **Backend**: build Docker image từ `backend/Dockerfile` (chạy `server.js`, cổng 5000); cấu hình `MONGO_URI`, `JWT_SECRET`, `PORT` qua biến môi trường (Render/Railway/VPS). Ở production bắt buộc có `CORS_ORIGIN` (URL frontend đã deploy); nếu chạy sau proxy (Render, Railway) đặt `TRUST_PROXY=1` để giới hạn đăng nhập tính đúng IP người dùng:

```bash
docker build -t project-manager-api backend
docker run -p 5000:5000 --env-file backend/.env project-manager-api
```
