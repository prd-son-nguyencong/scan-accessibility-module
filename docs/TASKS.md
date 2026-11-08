# ada-scan: danh sách task để hoàn thiện sản phẩm

Nguồn: `REVIEW-2026-10-26.md` (329 finding + NEW-1..5), `WAVE0-PLAN.md`, và yêu cầu sản phẩm của chủ dự án.
Quy ước: size S (<= nửa ngày), M (1-2 ngày), L (3-5 ngày). `Dep` = task phải xong trước. "Gate" = điểm dừng kiểm chứng trước khi sang phase sau.

## 0. Định nghĩa sản phẩm hoàn thành

Tool phục vụ QA site Paradox Site Studio trước khi client duyệt. Hoàn thành khi:

1. **Scan đáng tin:** URL lỗi, page lỗi, layer lỗi luôn lộ ra (exit code và report). Không còn xanh giả.
2. **Quét trọn site:** 5-20 page từ danh sách tay, sitemap, thư mục build hoặc crawl; cảnh báo khi các nguồn chênh nhau.
3. **Đủ tiêu chuẩn:** accessibility (axe + accessScan), HTML validity, Lighthouse mobile >= 80 và desktop >= 90 (median 3 lần), kèm ngưỡng cấu hình được và báo "điểm thực tế / ngưỡng" từng page.
4. **Trace chuẩn:** mỗi lỗi chỉ về `file:line` với confidence thật; phần không sửa được ở source được gắn `platform-owned` hoặc `untraceable`, không đoán.
5. **Báo cáo dùng được:** một báo cáo QA cho PM/client (pass/fail theo tiêu chuẩn và page), một bộ task cho dev, so sánh giữa các vòng (đã sửa N, còn M, mới K).
6. **Fix handoff:** dev dùng Cursor hoặc Claude Code nhận task có đủ ngữ cảnh; CIS fix chạy qua pipeline có kiểm chứng thật, apply nguyên tử, rollback được.
7. **Chạy ổn định:** CI thật chặn merge, test hermetic, không treo, không rò dữ liệu, không ghi đè file của repo host ngoài ý muốn.
8. **Mở rộng framework:** HTML thuần, React/Next hoạt động qua adapter; Vue/Nuxt/Stencil hoãn (có chỗ cắm sẵn).

## 1. Quyết định (tôi chốt theo hướng sản phẩm; bạn đổi được ở bước review)

| Mã | Quyết định | Lý do ngắn |
|---|---|---|
| D1 | Khóa legacy fixer ngay, xóa write path ở T-E6.2; giữ exporter cursor/windsurf/vscode làm nền cho handoff | Đang gây mất dữ liệu; exporter là nhu cầu thật |
| D2 | **Mọi gọi dịch vụ ngoài (W3C Nu, PSI) là opt-in** (`--allow-external` hoặc config), có thông báo "gửi dữ liệu tới <dịch vụ>". Mặc định dùng validator offline (`html-validate`) và Lighthouse local. Endpoint W3C cấu hình được | URL public không có nghĩa nội dung public: DOM đã hydrate của site client chưa phát hành có thể chứa token/PII (CLI-14) |
| D3 | Giữ Node 20.18.1, dùng `undici@^7` **nếu** test CIS pass; nếu không thì nâng `>=22.19`. Quyết bằng thử nghiệm ở T-E0.5 | Host ghim 20.18.1; không chọn mù |
| D4 | exit 0 sạch; 1 có violation vượt ngưỡng; **2 scan không hoàn chỉnh** (2 thắng 1). `--no-fail` không tắt exit 2; chỉ `--allow-incomplete` (ghi rõ trong report) mới tắt. Vite plugin: cảnh báo, không làm hỏng build | QA không được phép xanh giả; build không được vỡ vì scan |
| D5 | Bisect corpus trước; revert nếu lệch không chủ ý | Tránh reseed che hồi quy |
| D6 | Implement `suppress` (có audit và hạn dùng) và `thresholds`; xóa `customRules`; `source.*` thành cấu hình adapter trace | Cần cho sản phẩm; bỏ cái không dùng |
| D7 | Tên khách hàng/staging URL: id mờ + manifest local, `private:true`; làm **trước mọi lần push** (Phase 0) | OPS-10/20 |
| D8 | Paradox preset (`.d3afa4`, `[data-testid^="olivia"]`...) chỉ bật khi site khai báo preset `paradox` hoặc tự phát hiện từ HTML | Tránh áp luật Paradox cho site khác |
| D9 | Thêm `--profile standards|commercial-parity`, tách khỏi `--include-third-party`. **`standards` là mặc định cho mọi host và quyết định pass/fail**; `commercial-parity` là thông tin bổ sung (mục riêng trong report). Ghi profile vào report. *Đổi so với hành vi hiện tại (remote = parity); bạn đảo lại được nếu khách đối chiếu với scanner thương mại* | Pass/fail không nên dựa heuristic (ACC-30); mặc định khác nhau giữa local và remote làm sai so sánh (NEW-5) |
| D10 | Bỏ số ROI hard-code; "Compliant" đổi thành "No automated issues found" kèm cảnh báo về giới hạn quét tự động | Số liệu giả làm mất uy tín báo cáo |
| D11 | Cờ `--profile` ở Phase 2 (E3.8); tách mã vendor-parity khỏi signals ở Phase 5 (E3.11) | Cần cho bảo trì, không chặn giá trị |
| D12 | State/session của fix nằm ngoài repo (thư mục state theo user) | Không bẩn repo host |
| D13 | Trust anchor CIS chỉ từ env tiến trình hoặc `~/.config`, không từ `.env` của project | Chống cấu hình độc hại từ repo |
| D14 | Shadow build: dùng `node_modules` của project qua symlink/clone chỉ-đọc + smoke build baseline | Nhanh và không cài lại |
| D15 | Một state machine fix duy nhất, nối vào review state | Xóa code chết |
| D16 | UA thật; form-submit probe tắt mặc định, chỉ opt-in | Không gửi dữ liệu lên site thật |
| DX-1 | Chuyển CI vào repo module | Hiện không chạy |
| DX-2 | Page 404/500 hợp lệ qua `allowStatus` | Site Paradox có sẵn |
| DX-3 | Verify route ngoài `/` fail-closed tới khi T-E7.3 xong | An toàn hơn pass giả |
| DX-4 | CI test non-blocking tới Gate 2, **blocking từ Phase 3**; Gate 6 chỉ xác nhận | Test hiện đỏ |
| DX-5 (mới) | Mọi đường ghi report/ROI/dist có `--out-dir` và mặc định ghi vào `<project>/.ada-scan/` (đã gitignore) | NEW-4: không ghi đè file git theo dõi |
| DX-6 (mới) | Commit cục bộ từng task nhỏ trên nhánh làm việc. **Không push khi chưa có OK của bạn.** Tại Gate 0 tôi hỏi một lần: cho push nhánh feature (không bao giờ `main`) để CI chạy. Không merge vào `main` khi chưa qua gate. Phải xong E0.9 trước khi push | Push là hành động hướng ra ngoài; CI cần code được push |
| DX-7 (mới) | Worktree đặt **ngoài** cây repo host (`~/Documents/ada-scan-worktrees/`); mỗi worktree tự cài dependency, dùng cổng và thư mục tmp riêng; mỗi task khai báo trước tập file | Tránh Node nhặt nhầm `node_modules` của host; tránh va chạm test song song |
| DX-8 (mới) | Không scan thật vào repo host trước khi E0.4 merge; build instrumented chạy trên bản sao project, không đụng `dist` của host; không khôi phục `scan-reports/*` của host khi chưa có OK của chủ repo | NEW-4 |

## 2. Danh sách task

### E0. Nền tảng (Phase 0)

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E0.1 | Test hermetic: `ADA_SCAN_ROOT` + chặn đọc `.env` cha, fixture thay vì đọc file host, `requireBrowser(t)`, sửa comment làm hỏng test source-grep | OPS-3/5/6/21, TRC-25, FIX-38, ACC-40 | S | - |
| T-E0.2 | Baseline: chạy full suite trên Node 20.18.1 và 24, ghi số liệu; bisect corpus (D5); khôi phục xanh hoặc loại test hỏng có lý do | OPS-2, D5 | S | E0.1 |
| T-E0.3 | CI: chuyển vào repo module, job test + corpus (non-blocking), matrix Node, commit lockfile, `private:true`, `.gitignore`, xóa script chết | OPS-1/13/16/17/19/20/24/30/33, DX-1 | M | E0.1 |
| T-E0.4 | `--out-dir` và thư mục output mặc định ngoài vùng git theo dõi | NEW-4, DX-5 | S | - |
| T-E0.5 | Thử `undici@^7` trên Node 20 chạy test CIS; chốt D3 | OPS-19 | S | E0.3 |
| T-E0.7 | **Golden runner**: chạy scan trên fixture local với browser ghim phiên bản, chuẩn hóa và diff finding theo khóa tạm (rule + selector + route), có bước **duyệt thay đổi golden có chủ ý** (tránh che hồi quy kiểu D5); scan preview thật chỉ là smoke check tham khảo (nội dung sống, Lighthouse dao động) | advisor | M | E0.6 |
| T-E0.8 | Khóa legacy fixer (chuyển từ E6.1): default `--fix` = `cis`, `--legacy-fix` có banner, từ chối `--dry-run` ghi file, bỏ `git stash`, bind 127.0.0.1 | LEG-1/2/6/7/8/32/33, CLI-23 | S | - |
| T-E0.9 | Dọn tên khách hàng/staging URL: id mờ, manifest local, `private:true` (chuyển từ E8.3); **điều kiện trước khi push** | OPS-10/20, D7 | M | E0.3 |
| T-E0.6 | Fixture site thật: dựng bộ HTML tĩnh mô phỏng Paradox (snippet, marker, widget, title rỗng, viewport sai...) làm golden cho scan và trace | mới | M | E0.1 |

### E1. Độ tin cậy của scan (Phase 1)

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E1.1 | Stop xanh giả: `scanFailed` thành exit 2; `pagesFailed`/`scannerErrors` trong summary; status >= 400 là failed (trừ `allowStatus`); phát hiện challenge/bot page; `non-document-error` thành partial; trạng thái Lighthouse vào summary; banner HTML cho scan không hoàn chỉnh; `--allow-incomplete` | CLI-1, RPT-2, SCN-1/12/17, D4, DX-2 | L | E0.1 |
| T-E1.2 | Config fail-closed: JSON hỏng thì dừng (CLI và Vite); `validateConfig` có schema; một argv parser strict (`--help`, `--layers=x`, giá trị thiếu/sai, cờ xung đột); `thirdParty`/preset đúng D8; load config một lần | CLI-2/5/6/7/8/11/20/21/24/32/33, D6, D8 | M | E1.1 |
| T-E1.3 | `resolveProject(config)`: một nguồn cho `outDir`/root/dist; bỏ `dist` hard-code (6 chỗ); Vite plugin `configResolved` + `closeBundle order:post` + ghi nguyên tử; `init` không làm hỏng `vite.config` | CLI-3/4/16/19/25/30, TRC-5/18/19/23 | M | E1.2 |
| T-E1.4 | Chống mất scan: try/catch từng test của layer, memoize và relaunch browser, đóng context, `load` + idle giới hạn thay cho networkidle 60s+60s, links HEAD→GET fallback, downgrade thay vì throw khi validate, ghi report tmp+rename | SCN-3/4/5/7/8/13/29/42, RPT-6/10/14, TRC-6/7/14 | M | E1.1 |
| T-E1.5 | Shared page session: mở page một lần, layer chỉ-đọc chạy `Promise.allSettled`, layer có mutate dùng context riêng, áp hook và `--no-hydrate-jobs` cho mọi layer, Lighthouse tuần tự | SCN-2, CLI-12/13, ACC-25 | L | E1.4 |
| T-E1.6 | Vòng đời process: detached + kill cả group, SIGINT/SIGTERM dọn dẹp, timeout build kill group, không để dev server mồ côi | CLI-15, FIX-13, SCN-42 | M | E1.4 |
| T-E1.7 | Chạy nhiều page: concurrency thật, retry có giới hạn, lỗi một page không chặn page khác, tiến độ rõ | mới | M | E1.5 |

### E2. Khám phá page

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E2.1 | Resolver page ưu tiên: `--page`/config → sitemap (URL hoặc file) → quét `dist/**/*.html` → `src/pages` (Liquid, trừ `excludedPages`) → crawl link nội bộ (giới hạn số page và độ sâu) | NEW-2 | M | E1.2 |
| T-E2.2 | Cảnh báo chênh giữa các nguồn (page trong sitemap mà không có ở build và ngược lại); xử lý sitemap 403/index sitemap/gzip | NEW-2 | S | E2.1 |
| T-E2.3 | Chuẩn hóa route: query/hash, trailing slash, locale; không để cùng route khác query làm crash | TRC-1, RPT-16 | S | E2.1 |

### E3. Chất lượng quét

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E3.1 | Scanner layers sửa S: focus-trap duyệt mọi trigger và đúng phần tử, Escape check, focus-indicator/focus-order, skip link ngoài màn hình, SVG ẩn, layout table, aria-live SVG | SCN-6/9/10/19-28/30-35/37-40 | M | E1.4 |
| T-E3.2 | accessScan rule correctness S: label cho input/select/textarea, `LinkAnchorDiscernible` mọi `a[href]`, evaluator chết, metric key, redact rỗng | ACC-1/2/9/10/11/13-23/33/36/37 | M | E0.1 |
| T-E3.3 | Accessible-name model đúng, **tái dùng CDP `Accessibility.getPartialAXTree` hoặc `dom-accessibility-api`**, không tự viết accname: bỏ gán text subtree cho `div`, `value` không là tên, bỏ text `display:none`, tính alt/aria-label của con | ACC-7/8/12/43 | L | E3.2 |
| T-E3.4 | accessScan hiệu năng và deadline: index label/element theo snapshot (O(n)), deadline hủy thật (worker), `frameSiblingIndex` đúng, shadow/iframe, viết lại focus-obscuration | ACC-4/5/6/24/26/27/28/38/39/42 | L | E3.3 |
| T-E3.5 | Egress opt-in cho W3C/PSI: `--allow-external`/config, thông báo trước khi gửi, endpoint cấu hình, host private không bao giờ gửi, `non-document-error` không thành "passed" (gộp egress notice) | CLI-14, SCN-11/12/30, D2 | M | E1.4, E8.1 |
| T-E3.10 | **Validator HTML offline mặc định** (`html-validate`; vnu.jar tùy chọn nếu có Java) chạy trên DOM đã render và trên HTML build; W3C Nu chỉ là lớp thêm opt-in. Thêm dependency cần bạn duyệt | advisor | M | E1.4 |
| T-E3.11 | Tách mã vendor-parity khỏi signals (pack riêng) | ACC-29/34, D11 | L | E3.8 |
| T-E3.6 | Lighthouse **local mặc định** (PSI opt-in): mobile và desktop, median 3 lần với **ngân sách thời gian** (13 page x 2 x 3 = 78 lần; có `--lighthouse-runs`, mặc định 1 cho vòng lặp nhanh, 3 cho lần chốt QA), a11y finding có impact và WCAG ref đúng, ghi provenance | SCN-14/15/16/18/38, mới | L | E1.5, E8.1 |
| T-E3.7 | Thresholds (**ngưỡng performance chỉ áp cho preview hoặc build production**; trên dev server vite chưa minify chỉ báo tham khảo): schema theo form factor (mobile 80, desktop 90, bestPractices/seo 90, a11y theo mức, W3C errors 0), gate và exit code theo ngưỡng, hiển thị điểm thực tế / ngưỡng | mới, D4/D6 | M | E3.6, E1.1 |
| T-E3.8 | `--profile` tách khỏi third-party; `standards` mặc định mọi host; ghi profile và nguồn vào report; parity là mục bổ sung | ACC-30, D9 | M | E1.2 |
| T-E3.9 | Rule count/docs sinh từ registry (`docs:rules`) và test đếm | ACC-31, OPS-27/28 | S | E3.2 |

### E4. Trace về source

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E4.1 | Pipeline `traceElement` hợp nhất trả danh sách ứng viên; `high` chỉ khi duy nhất; `ambiguous`/`untraceable` có lý do; test trực tiếp cho `liquid-tag-index` | TRC-8-13/15, TRC-9 | L | E0.6, E1.3 |
| T-E4.2 | **Bước 1 là spike đo** tỷ lệ khớp trên fixture (ngưỡng ở Gate 3). Bản đồ build local làm tham chiếu cho preview: lập chỉ mục fingerprint (tag, class, text rút gọn, vị trí) → `snippets/*:dòng`; khớp violation từ preview; chịu được khác biệt nhỏ | NEW-3 | L | E4.1 |
| T-E4.3 | Phân loại `platform-owned` (widget `data-react-component`, `component_data`, page khóa, iframe bên thứ ba) và cảnh báo khi source local lệch bản đã push (so nội dung snippet với export) | NEW-5 | M | E4.2 |
| T-E4.4 | Attestation theo content hash (plugin ghi sha256), preimage từ build; scope check query/hash; reason enum thống nhất | TRC-1/2/3/4/16/17/20-22/24 | M | E1.3 |
| T-E4.5 | Interface adapter + phát hiện framework tự động (`package.json`, `*.config.*`) | mới | M | E4.1 |
| T-E4.6 | Adapter HTML thuần: parse có vị trí dòng, khớp phần tử | mới | M | E4.5 |
| T-E4.7 | **Spike trước** (Next dùng SWC, không có plugin Babel attribute: cần plugin SWC/wasm hoặc tắt SWC), rồi adapter React/Next: `data-src="file:line"` (không dựa `__source` vì React 19 bỏ), fallback source map | mới | L | E4.5 |
| T-E4.8 | Fixture thật cho từng adapter, test hồi quy trace với số liệu "đúng/ambiguous/untraceable" | mới | M | E4.6, E4.7 |

### E5. Báo cáo và QA gate

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E5.1 | Escape HTML dùng chung (XSS), xóa `html-report.js` chết, bỏ ROI hard-code (D10) | RPT-1/4/5/13/15/21 | M | E0.1 |
| T-E5.2 | Report integrity: đếm đúng (cộng, không `max`), route identity, validate khi load, `stableId` để diff, timestamp lịch sử độ phân giải đủ, atomic write | RPT-3/7/8/12/17-20/23/24 | M | E1.1 |
| T-E5.3 | Baseline thật: so với lần scan trước theo `stableId`; báo "đã sửa N, còn M, mới K" | RPT-11 | M | E5.2 |
| T-E5.4 | Báo cáo QA cho PM/client: tổng hợp pass/fail theo tiêu chuẩn và page, điểm thực tế / ngưỡng, nguồn và profile, danh sách `platform-owned` tách riêng, cảnh báo giới hạn quét tự động | mới | L | E3.7, E4.3, E5.2 |
| T-E5.5 | Export SARIF và JSON schema công bố cho ScanReportV2 | mới | M | E5.2 |

### E6. Handoff cho dev và gỡ legacy

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E6.2 | Xóa write path legacy (rules, engine ghi, agent, ui, ai-*, modes claude/codex/cis) | LEG-3..10/29-31/34/37 | M | E0.8, E6.4 |
| T-E6.3 | `ada-scan fix --export`: mỗi lỗi một mục (rule, WCAG, file:line, snippet, confidence, gợi ý sửa, ghi chú platform-owned) cùng file tổng | mới | M | E4.3, E5.2 |
| T-E6.4 | Exporter Cursor và Claude Code: ghi vào `.ada-scan/tasks/*` và một file quy tắc **do tool sở hữu** (`.cursor/rules/ada-scan.mdc`, đánh dấu), **tạo hoặc cập nhật file của chính nó, không bao giờ ghi đè file của user** (không sửa `CLAUDE.md`, chỉ in hướng dẫn thêm dòng import). Sửa LEG-27/28, chuyển sang `src/fix/export` | LEG-27/28/39 | M | E6.3 |
| T-E6.5 | Vòng lặp "scan → sửa → scan lại" kiểm chứng bằng baseline và test e2e trên fixture | mới | M | E5.3, E6.4 |

### E7. Trusted fix qua CIS

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E7.1 | Verification trung thực tối thiểu: `sourceTraceResolved` thật, `targetFindingIds` rỗng không pass, route chưa quét báo `NOT_RESCANNED`, broker kiểm `expectedSha256`, bỏ nhận `preimageRange`/`fixPolicy` do report cung cấp | FIX-2/3/4/26/27/28/35, DX-3 | M | E4.1 |
| T-E7.2 | Apply nguyên tử: bắt lỗi `postVerify` và rollback, WAL ghi trước rename, recovery khi khởi động, lock không kẹt, giữ lock qua post-verify | FIX-15/16/17/18/19/20/21 | L | E7.1 |
| T-E7.3 | Shadow verify thật: scan đúng `affectedRoutes` và layers, kiểm HTTP status, baseline build, prepare mặc định (D14), formatter trong bản được apply, mutex/port 0 | FIX-1/5/6/7/10/11 | L | E7.1, E2.3 |
| T-E7.4 | Workbench: guard `APPLY_STARTED` bền, reload sau apply không `CORRUPT_SESSION`, nút rollback, banner insecure-dev, diff-view, snapshot phân trang, propose có khóa/abort, lỗi thật | CIS-5..10/13-16/37/45 | L | E7.2 |
| T-E7.5 | Parser CIS structural allowlist (bỏ `javascript:`, `onerror`, `<script>` protocol-relative; cho phép sửa href/src hợp lệ), giới hạn/repair, TLS/trust anchors (D13), telemetry có cap và redact | CIS-1..4/17-32/48/49 | L | E7.1 |
| T-E7.6 | Generator `mechanically_safe` (html-has-lang, lang hợp lệ, document-title, `rel` cho `_blank`, `alt=""` trang trí, viewport) chạy qua cùng pipeline | FIX-24/25/37, LEG re-author | L | E7.3, E6.2 |
| T-E7.7 | Một state machine fix (D15), tách `review/state.js`, context window mở rộng, vòng repair | FIX-8/9/12/14/22/29/30/36/40, CIS-12/33/36/38/40/42/44/46/47 | L | E7.4 |
| T-E7.8 | Live acceptance với CIS thật trên fixture (không còn fixture synthetic) | CIS-44 | M | E7.5, E7.3 |

### E8. Bảo mật và riêng tư

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E8.1 | `classifyHost()` một nơi: IPv6 đặc biệt, TEST-NET, `localhost.evil.com`, `user:pass@`; guard `capture --url` | CLI-9, FIX-31, RPT-22, OPS-7/8, SCN-14 | M | - |
| T-E8.4 | CSP cho report HTML, redact query trong URL báo cáo, bỏ khóa trùng, hardening server local | RPT-1(CSP)/18, CIS-11/22/23/27/34 | M | E5.1 |

### E9. Vận hành, docs, tiện ích

| ID | Task | Gốc | Size | Dep |
|---|---|---|---|---|
| T-E9.1 | `ada-scan doctor`: kiểm Node, browser, lockfile lệch (NEW-1), dev server, CIS env, quyền ghi output | NEW-1 | M | E1.3 |
| T-E9.2 | `init` an toàn và có `--dry-run`; README, CHANGELOG, docs khớp code (số layer, rule, test), cập nhật plan CIS | CLI-26-31, CIS-43, OPS-26/29 | M | E3.9 |
| T-E9.3 | Corpus/drift: sửa `run-drift-nonblocking.sh`, reseed theo D5, `--host-resolver-rules`, test không flaky | OPS-9/12/14/15/18/22/23/31/32 | M | E0.2, E8.1 |
| T-E9.4 | Bộ test: layer hành vi, `runCli`/`runScan` e2e, golden reporter, coverage script, CI blocking | OPS-25, FIX-39, ENH | L | E1.5 |
| T-E9.6 | **Cần chủ repo host duyệt:** đồng bộ phía host cho NEW-4 (bản scanner nhúng cũ `scripts/scan/` và các script `scan:*` đang trỏ về bản cũ; lockfile và `postinstall` lệch) | NEW-1/4 | S | E0.8 |
| T-E9.5 | Dọn code chết và cap telemetry | CLI-26/27/31, ACC-32, CIS-24/39, LEG-9 | S | - |

### E11. Độ chính xác và niềm tin vào kết quả (thêm sau review tầm nhìn)

Lý do: corpus hiện có đo mức **khớp với một scanner thương mại (oracle)**, không đo **đúng hay sai theo WCAG**. Reviewer đã tìm thấy false positive thật (links báo 403/405 là chết, `ButtonDiscernible` báo nhầm `<button><img alt>`, skip link ngoài màn hình) và false negative thật (không có rule label cho input/select/textarea). Không có số đo thì không thể nói tool "đúng".

| ID | Task | Size | Dep |
|---|---|---|---|
| T-E11.1 | **Bằng chứng cho từng finding:** đoạn DOM, style/hình học đã tính, ảnh chụp cắt có khung phần tử, lý do rule kết luận, link tiêu chí WCAG, bước tái hiện (selector + trạng thái trang). Report hiển thị "vì sao bị báo" | M | E5.2 |
| T-E11.2 | **Phân loại độ chắc chắn theo bản chất rule:** mỗi rule trong registry gắn `deterministic` / `heuristic` / `manual`. Finding có verdict `confirmed` / `likely` / `needs-review`, không chỉ severity. Pass/fail tự động chỉ dựa trên `confirmed` | M | E3.2 |
| T-E11.3 | **Bộ test lỗi gieo sẵn (seeded-fault):** mỗi rule có trang fixture chứa đúng lỗi nó phải bắt, và trang "sạch" tương ứng nó phải im lặng. Đo TP/FP/FN theo rule, đưa vào CI. Bắt đầu với các rule accessScan và nhóm axe đang dùng | L | E0.6, E0.7 |
| T-E11.4 | **Đối chiếu nhiều engine độc lập:** finding được 2 engine trở lên báo (axe, accessScan, Lighthouse a11y, html-validate/Nu, tùy chọn Pa11y) là độ tin cậy cao; chỉ một engine heuristic báo thì `needs-review`. Report có cột "engine đồng thuận" | M | E3.10, E11.2 |
| T-E11.5 | **Tái kiểm chứng chống nhiễu:** mỗi finding được kiểm lại trong context mới (và viewport khác nếu liên quan); không ổn định thì đánh dấu flaky và không tính vào pass/fail. Theo dõi tỷ lệ flaky theo rule | M | E1.5 |
| T-E11.6 | **Tập nhãn thật từ QA của team:** nút "đúng/sai" cho từng finding trong report, lưu nhãn vào file local; tính precision theo rule theo thời gian; rule có precision thấp bị hạ xuống `needs-review` hoặc cảnh báo bảo trì | L | E11.1, E5.2 |
| T-E11.7 | **Corpus theo sự thật:** bổ sung corpus gắn nhãn đúng/sai theo WCAG (từ E11.3 và E11.6), giữ corpus parity như chỉ số phụ; ghi rõ mỗi chỉ số đo cái gì | M | E11.3 |
| T-E11.8 | **Ma trận độ phủ:** từ registry sinh bảng "tiêu chí WCAG 2.2 AA nào có rule tự động, cái nào cần kiểm tay, cái nào chưa có"; đưa câu "tự động bao phủ X/Y tiêu chí" vào báo cáo | M | E3.9, E11.2 |
| T-E11.9 | **Quy trình kiểm tay:** danh sách việc cần người (chỉ dùng bàn phím, screen reader, zoom/reflow, phụ đề...), ghi người ký duyệt và ngày; báo cáo hiển thị "tự động đạt, kiểm tay còn N mục" thay vì "đạt" | M | E5.4 |

**Ngưỡng chấp nhận (đặt trước khi làm):** rule `deterministic` đạt 0 FP và 0 FN trên seeded suite; rule `heuristic` luôn ở `needs-review` trừ khi có >= 2 engine đồng thuận; tỷ lệ finding flaky < 2% trên fixture.

### E12. Tầm nhìn dài hạn (sau Phase 6, làm khi bạn xác nhận cần)

| ID | Task | Size |
|---|---|---|
| T-E12.1 | **Gom theo nguyên nhân gốc:** cùng một lỗi ở header/footer lặp trên 13 page thành một issue (theo snippet nguồn), kèm danh sách page bị ảnh hưởng. Cho dev ít task hơn nhiều | M |
| T-E12.2 | **Giám sát liên tục:** GitHub Action quét preview theo lịch và khi có PR, comment tóm tắt, ngân sách hồi quy (chỉ fail với lỗi **mới** so với baseline) | M |
| T-E12.3 | **Xuất issue tracker:** Jira/CSV theo nhóm nguyên nhân gốc, gắn file nguồn và bằng chứng | M |
| T-E12.4 | **Xuất bản nháp báo cáo tuân thủ (ACR/VPAT)** từ kết quả tự động và chữ ký kiểm tay | L |
| T-E12.5 | **Xu hướng đa site:** lịch sử điểm theo site và theo thời gian | M |
| T-E12.6 | **Plugin API chính thức** cho rule, adapter trace, reporter (thay `customRules` đã xóa) | L |

### E10. Hoãn có chủ đích

- Adapter Vue/Nuxt và Stencil (chỗ cắm sẵn ở T-E4.5; quay lại sau khi tool ổn định, theo chủ dự án).
- Chuyển evaluator chạy worker riêng (đã gộp trong T-E3.4 nếu đủ thời gian; nếu không thì tách riêng).

## 3. Phase và gate

| Phase | Task | Gate (phải đạt mới sang phase sau) |
|---|---|---|
| 0 Nền tảng | E0.1-E0.9, E8.1 | Full suite xanh và hermetic trên Node ghim; golden runner chạy được trên fixture; legacy đã khóa; tên khách hàng đã dọn; hỏi OK push nhánh feature để bật CI |
| 1 Tin cậy | E1.1-E1.4, E1.6, E2.*, E9.5 | URL chết exit 2; config hỏng dừng; scan 13 page preview xong ổn định; không ghi đè file git theo dõi |
| 2 Chất lượng | E1.5, E1.7, E3.1-E3.10, E5.1, E5.2, E11.1, E11.2, E11.3, E11.5 | Seeded-fault suite chạy trong CI và đạt ngưỡng E11; golden runner: mọi thay đổi finding được duyệt có chủ ý; hiệu năng accessScan 36k element < 20s; Lighthouse mobile+desktop median 3 |
| 3 Trace và báo cáo | E4.*, E5.3-E5.5, E8.4 | Trên fixture (số đặt **trước** khi làm, chốt sau spike E4.2): 0 kết quả `high` sai; tối thiểu 80% phần tử traceable được trace đúng (high hoặc medium); phần còn lại là ambiguous/untraceable; báo cáo QA đọc được bởi PM; CI chuyển sang blocking |
| 4 Handoff | E6.2-E6.5, E9.1, E9.2, E9.6, E11.4, E11.6-E11.9 | Dev dùng Cursor và Claude xử lý bộ task export, quét lại thấy "đã sửa" đúng |
| 5 Auto-fix | E7.*, E3.11 | CIS live acceptance; apply/rollback chịu failure-injection |
| 6 Hoàn thiện | E9.3, E9.4 + rà soát toàn bộ | CI blocking; review cuối bởi reviewer độc lập; tài liệu khớp code |

## 4. Cách tôi sẽ thực thi khi bạn nói "go" (Workflow)

- **Một workflow cho mỗi phase**, đọc kết quả trước khi chạy phase kế tiếp (tôi vẫn ở trong vòng lặp), theo mẫu: triển khai → kiểm chứng độc lập → review đối kháng → merge theo thứ tự.
- **Mỗi task:** agent triển khai trong **worktree riêng** (chỉ khi các task không chạm chung file; task chung `index.js` chạy tuần tự), agent kiểm chứng chạy test và lệnh thật, agent review đối kháng cố bác bỏ. Task chỉ được merge khi test của nó và toàn bộ suite pass.
- **Cuối mỗi phase:** golden regression (scan preview và local trên fixture, so với baseline), chạy full suite, rồi dừng báo cáo cho bạn trước phase tiếp theo nếu có quyết định phát sinh hoặc gate không đạt.
- **Quy tắc an toàn:** xem DX-6/7/8. Commit cục bộ; push chỉ khi bạn OK; worktree ngoài cây repo host, mỗi worktree cài riêng và dùng cổng/tmp riêng; mỗi task khai báo tập file trước (các task cùng chạm `src/index.js` chạy tuần tự); không scan thật vào host trước E0.4, build instrumented chạy trên bản sao; mọi scan thật dùng `--out-dir` riêng. Golden regression dựa trên fixture; scan preview thật chỉ là smoke tham khảo.
- **Dừng và hỏi** khi: thử nghiệm D3 cho kết quả không rõ, corpus cần payload oracle mới (ToS bên thứ ba), CIS live cần credential, hoặc một task lộ ra phạm vi lớn hơn dự kiến.
- **Không làm:** Vue/Nuxt/Stencil, xóa fixer cũ trước khi exporter thay thế sẵn sàng.

## 5. Rủi ro chính

| Rủi ro | Giảm thiểu |
|---|---|
| E3.3/E3.4/E4.2/E4.7 là phần khó nhất, có thể vượt ước lượng (E4.7 phụ thuộc kết quả spike SWC) | Spike trước, làm trên fixture, đo tỷ lệ đúng; dừng báo cáo nếu dưới ngưỡng |
| Đổi exit code/default làm vỡ script của team | CHANGELOG nổi bật, `--allow-incomplete` (D4), thông báo khi chạy |
| Trace từ preview dựa fingerprint có thể sai khi nội dung Studio khác local | Confidence thật, `ambiguous` thay vì đoán, cảnh báo lệch bản |
| CIS chưa kiểm chứng live | E7.8 là điều kiện bắt buộc trước khi gọi pipeline là xong |
| Test hiện đỏ che hồi quy | E0.1/E0.2 làm trước tiên |
