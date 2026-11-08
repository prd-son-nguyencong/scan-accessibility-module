# ada-scan Wave 0: kế hoạch triển khai

Nguồn: `docs/REVIEW-2026-10-26.md` (mục 3, 4, 6, Phụ lục A) và 8 báo cáo chi tiết. Module root: `scan-accessibility-module/` (repo riêng, branch `main`, base `bd28fc1`, NEW-1 đã sửa). Host: `<host-repo>`.
Cite `file:line` dưới đây đã đối chiếu source hiện tại cho cite đầu tiên của mỗi bundle (đánh dấu ✓); các cite còn lại lấy từ báo cáo, lệch vài dòng thì tìm theo symbol. Effort là ước lượng (S <2h, M <1d).

## 1. Mục tiêu và Definition of Done

Mục tiêu: scan URL preview (chế độ chính) không còn "xanh giả", không mất scan, không crash layer; `--fix` mặc định không phá source; test suite đáng tin; CI chạy được.

DoD đo được (tất cả phải đạt trước khi đóng Wave 0):

| # | Tiêu chí | Lệnh kiểm | Kỳ vọng |
|---|---|---|---|
| 1 | URL không tới được | `ada-scan --url https://does-not-exist.invalid/ --layers axe --fail-on-violations` | exit 2, banner "Incomplete scan", `latest.json` có `summary.pagesFailed=1` (baseline hiện tại: exit 0, "Total violations: 0") |
| 2 | URL trả 404 | `--url <preview>/this-page-does-not-exist --layers axe` | exit 2 (baseline: scan trang 404 như site thật, 14 violation) |
| 3 | Config hỏng | `.scan-config.json` cắt cụt, chạy CLI và Vite plugin | exit 1, không rơi về default |
| 4 | `thirdParty: []` | test | tắt hẳn default Paradox |
| 5 | `--fix` | `ada-scan --fix --dry-run --fix-mode claude` | exit 1, 0 file đổi; `--fix` trần đi đường `cis`; không còn `git stash` trong `src/` |
| 6 | Report escape | fixture hostile (page name `x');alert(1);('`, ruleId có `"><img onerror>`) | HTML không chứa handler/tag chèn; `src/reporter/html-report.js` đã xoá |
| 7 | Layer không chết | SVG `class="icon-alert"`, accordion button ẩn | aria-live/dynamic-content trả kết quả một phần, <10s |
| 8 | Report không mất | finding keyboard có source `originFile` | `latest.json` vẫn ghi; downgrade kèm `diagnostics[]` |
| 9 | Full suite | `node --test test/*.test.js test/fix/*.test.js` (Node theo D3, `.env` thật của host vẫn tồn tại) | 0 fail do env/host/fixture; fail còn lại chỉ thuộc nhóm đã biết (corpus 9 chờ D5, workbench 7 chờ 1.5, flaky <=2); ghi số thực |
| 10 | Golden preview | mục 2.6 | `occurrenceCount` standards=58, parity=79 (axe 21) không đổi sau mọi bundle trừ 0.9, 0.10 (diff phải giải thích theo ruleId) |
| 11 | CI | push lên module repo | job `test` chạy (chưa blocking), `corpus-verify` chạy đúng thư mục |

## 2. Pre-flight

### 2.1 Baseline đã ghi (2026-10-26)
- Test: 1392 tests, 1362 pass, 30 fail, 620 s, Node 24.13.0 (OPS report). Nhóm fail: corpus 9, `.env` cha rò vào test 13, workbench 7, fixture thiếu 1, coupled host 1, source-grep 1, flaky 2 (các nhóm có chồng lấn, tổng không cộng thẳng).
- Repo pin Node 20.18.1 (file `.nvmrc` nằm ở **host** `../.nvmrc`, module không có); `undici@^8` cần `>=22.19` (lock chưa commit: `M pnpm-lock.yaml`, +9 dòng). Máy này không có Node 20.18.1; có 22.18.0, 22.21.1, 22.23.3, 24.13.0. Đã chạy thử `test/fix/cis-transport*.test.js` trên 22.18 và 22.23.3: 59/59 pass.
- Golden preview đã chạy lại (49 s mỗi lần), khớp NEW-5: standards `occurrenceCount=58` (finding 57; accessScan 37 + axe 21), commercial-parity `79` (finding 69; accessScan 58 + axe 21).
- Repro P0: `https://does-not-exist.invalid/` exit 0 kể cả có `--fail-on-violations`; URL 404 của preview bị scan như site thật.
- Working tree module: `M pnpm-lock.yaml`, `?? .pw.cjs`, `?? test/.tmp-accessscan-corpus-tests/`, `?? docs/REVIEW-2026-10-26.md`.
- Host dirty sẵn (đừng nhầm là do Wave 0): `M pnpm-workspace.yaml`, `M scan-reports/{latest.json,roi-*.html,scan-visual.html}`, nhiều `scan-reports/history/*`.

### 2.2 Branch và commit
- Remote `origin = <org>/scan-accessibility-module`. Tag `wave0-base` tại `bd28fc1`.
- Mỗi bundle một branch `wave0/<id>-<slug>` (vd `wave0/0.1-false-green`), một PR nhỏ vào `main`, squash hoặc rebase, không merge commit. Bundle lớn tách commit con (0.4a/b/c, 0.5a/b/c, 0.6a/b, 0.12a/b), mỗi commit một PR được.
- Conventional commits: `fix(cli): ...`, `fix(scanner): ...`, `fix(reporter): ...`, `fix(fix): ...`, `chore(ci): ...`, `test: ...`, `docs: ...`. Body liệt kê ID (vd `CLI-1, RPT-2`). Mỗi PR thêm một dòng vào `CHANGELOG.md [Unreleased]`.
- Mỗi PR phải có: test mới (tên ở mục 5), `node --test` các file liên quan xanh, golden preview (nếu bundle chạm scan/report) đúng bảng DoD 10.
- Commit `docs/REVIEW-2026-10-26.md` và file này trước (`docs: add review and wave0 plan`).

### 2.3 Chạy test hermetic (trước khi 0.8 land)
Nguyên nhân 13 test đỏ: `getProjectRoot()` đi ngược lên host (có `.scan-config.json`), `config.js:7-12` nạp `../.env`, `trusted-deployment-url.js:25` cho env thắng config. Cách nhanh, đã kiểm chứng (4 file attestation: 49/49 pass, so với 13 đỏ):

```
cd <module>
export ADA_SCAN_ROOT=$PWD ADA_SCAN_DEPLOYMENT_URL=
node --test test/<file>.test.js            # một file
node --test test/*.test.js test/fix/*.test.js 2>&1 | tee /tmp/wave0-full.txt   # full ~10 phút
```
Danh sách test đỏ để so trước/sau: `node --test --test-reporter=tap ... | grep '^not ok' | sort > fails-<tag>.txt`.

### 2.4 Node
Chạy với Node theo D3 (mặc định giữ 20.18.1 + undici ^7). Máy chưa có 20.18.1: cài `nvm install 20.18.1` trước khi bundle 0.7, hoặc để CI matrix xác nhận.

### 2.5 Việc làm trước (P-tasks)
- P1 (S): `git bisect` OPS-2 để biết có phải đổi chủ ý. Chỉ 8 commit sau fixture `308eb2e`: `git bisect start HEAD 308eb2e && git bisect run node scripts/accessscan-corpus/verify.js`. Nghi: `9389afd` (rule 83, NavigationWrapperMissingRole) và `c2cbd08`. Kết quả quyết định D5, cần trước 0.10.
- P2 (S): `git tag wave0-base bd28fc1`; chốt lock theo D3 (làm trong 0.7).
- P3 (S): ghi baseline vào `$G/` (mục 2.6) và chép `fails-base.txt`.

### 2.6 Golden regression runs (NEW-4: scan ghi đè `scan-reports/` của host)
Report ghi vào `<ADA_SCAN_ROOT>/scan-reports`. Với preview (remote, không build) dùng root tạm có bản sao `.scan-config.json`, host không bị đụng, `.env` cha cũng không nạp:

```
MOD=<module>
HOST=<host-repo>
PREVIEW=https://site-690.preview.sites.stg.paradox.ai/
G=$HOME/ada-scan-golden/<tag>        # tag: baseline, after-0.1, ...
for p in exclude include; do mkdir -p $G/preview-$p && cp $HOST/.scan-config.json $G/preview-$p/; done
(cd $G/preview-exclude && ADA_SCAN_ROOT=$PWD node $MOD/bin/ada-scan.js --url $PREVIEW --layers axe,accessScan --exclude-third-party --no-fail)
(cd $G/preview-include && ADA_SCAN_ROOT=$PWD node $MOD/bin/ada-scan.js --url $PREVIEW --layers axe,accessScan --include-third-party --no-fail)
node -e 'const r=require(process.argv[1]);console.log(JSON.stringify(r.summary))' $G/preview-exclude/scan-reports/latest.json
```
Kỳ vọng baseline: `{"pagesScanned":1,"findingCount":57,"occurrenceCount":58,"layerCounts":{"accessScan":37,"axe":21}}` và `{"findingCount":69,"occurrenceCount":79,"layerCounts":{"accessScan":58,"axe":21}}`. Preview là staging sống: nếu chạy lại baseline mà lệch >2 trước khi đổi code thì re-baseline và ghi lại.

Golden local `:1234` (cần dev server đang chạy, build instrumented ghi `dist/` và `scan-reports/` của host; **chưa chạy thử khi lập plan**; NEW-5: standards 8, parity 10). Phải backup và khôi phục:
```
cp -R $HOST/scan-reports $G/host-scan-reports.bak && git -C $HOST status --short > $G/host-status.before
(cd $HOST && node $MOD/bin/ada-scan.js --url http://127.0.0.1:1234/ --layers axe,accessScan --exclude-third-party --no-fail)   # rồi --include-third-party
rsync -a --delete $G/host-scan-reports.bak/ $HOST/scan-reports/ && git -C $HOST status --short | diff - $G/host-status.before
```
Smoke các layer còn lại (không gate theo số): `--layers links,keyboard,focusTrap,ariaLive,dynamicContent,screenReader,w3c` trên preview; yêu cầu không layer nào `skipped/error` trong `scannerRuns` (dùng sau 0.5a và 0.9).
Repro cho 0.1 (chạy ở root tạm như trên): `--url https://does-not-exist.invalid/ --layers axe --fail-on-violations` và `--url ${PREVIEW}this-page-does-not-exist --layers axe`. Lưu ý `http://127.0.0.1:9/` không dùng được: bị coi là local, kích hoạt build và chết vì thiếu `package.json`.

## 3. Decisions cần chốt trước khi bắt đầu

| ID | Cần trước | Câu hỏi | Mặc định đề xuất |
|---|---|---|---|
| D3 | 0.7 | Node/undici | Giữ Node `>=20.18.1` và `.nvmrc` 20.18.1 (host cũng pin 20.18.1 nên nâng sẽ kéo theo đổi môi trường dev), hạ `undici` về `^7` (engines `>=20.18.1`), commit lock, CI matrix 20.18.1 + 22. Chưa chạy thử undici 7: thêm bước `pnpm add undici@^7` rồi chạy `test/fix/cis-*.test.js`. Phương án B: nâng `>=22.19` |
| D4 | 0.1 | Exit code | exit 2 khi có page failed hoặc 0 layer thành công, `--no-fail` không tắt exit 2 (thêm `--allow-incomplete` nếu cần). `--fail-on-violations` giữ exit 1. `--fail-on <severity>` để 1.1 |
| D1 | 0.3 | Xoá legacy fixer? | Wave 0 chỉ gate, không xoá. Giữ exporter `cursor/windsurf/vscode` chạy không cần cờ (đây là handoff cho Cursor/Claude Code). Xoá ở 1.13 |
| D5 | 0.10 | Corpus AltMisuse | Theo kết quả P1. Nếu chủ ý: reseed 124/203/731 trong một commit riêng trước 0.10, ghi CHANGELOG. Nếu không: revert commit gây lệch |
| DX-1 | 0.7 | CI đặt ở đâu | Workflow hiện ở `../.github/workflows` (host, trỏ `ada-scan/`). Module có remote riêng: chuyển vào `module/.github/workflows/`, bỏ `working-directory`. Host xoá bản cũ do chủ host |
| DX-2 | 0.1 | Trang hợp lệ trả 404/500 | Page `/404` và `/500` (site Paradox có sẵn) và `pages[].allowStatus: [404]` được phép; còn lại status >=400 là failed |
| DX-3 | 0.6a | FIX-1 interim | Chấp nhận fail-closed: target không thuộc route `/` báo `NOT_RESCANNED` cho tới 1.3 (đây là phần bổ sung ngoài bảng review) |
| DX-4 | 0.7 | CI test blocking? | Chưa. Non-blocking tới 1.12 |
| D2, D6-D16 | không cần | | D2: không đổi default egress trong Wave 0 (preview là public, A.8); chỉ sửa nhận diện host ở 0.4b |

## 4. Thứ tự đề xuất và phụ thuộc

Nguyên tắc: test đáng tin trước, rồi false-green / scan-lost / crash, rồi data-loss, rồi security, rồi tinh chỉnh rule (đổi số liệu nên đi sau cùng).

| Thứ tự | Bundle | Lý do | Phụ thuộc |
|---|---|---|---|
| 1 | 0.8 Test hermetic | Không có tín hiệu đỏ/xanh đúng thì không xác nhận được bundle nào; tạo helper dùng cho test layer | none |
| 2 | 0.7 CI + package | Mỗi PR sau chạy `pnpm test` (non-blocking); chốt D3/lock | 0.8, D3, DX-1 |
| 3 | 0.1 False-green | Blocker số một của scan preview | D4, DX-2, 0.8 (helper browser) |
| 4 | 0.2 Config fail-closed | Config sai làm scan sai im lặng; S | none |
| 5 | 0.5 Anti scan-loss (a, b, c) | Layer crash, report all-or-nothing, history ghi đè | 0.8 (helper), 0.1 (browser.js, w3c.js) |
| 6 | 0.3 Gate legacy fixer | Data-loss: `--fix` mặc định ghi file và `git stash` | D1 |
| 7 | 0.6 Fix verify trung thực (a, b) | Gate không verify; độc lập với scanner nên song song được | DX-3 |
| 8 | 0.4 Security (a, b, c) | XSS report, host classify | 0.5b (html.js), 0.1 |
| 9 | 0.9 Scanner layers S | Đổi finding của layer behavioral | 0.5a, 0.8 |
| 10 | 0.10 access-scan rules S | Đổi số liệu và hash corpus | D5, P1 |
| 11 | 0.11 Tracer/reporter S | Chạm html.js, index.js sau cùng | 0.4a, 0.5b |
| 12 | 0.12 Dead code, docs | Xoá code chết sau khi các bundle khác xong để khỏi conflict | tất cả |

Cần quyết định trước khi bắt đầu: D4+DX-2 (0.1), D3+DX-1 (0.7), D1 (0.3), DX-3 (0.6a), D5 (0.10). Các bundle còn lại bắt đầu ngay.

## 5. Chi tiết từng bundle

Quy ước: **Parallel** = có thể làm trong worktree riêng cùng lúc với bundle nào (xem mục 8). Test mới đặt trong `test/`; mọi test dùng browser phải gọi `requireBrowser(t)` (từ 0.8).

### 0.8 Test hermetic (S), làm trước tiên
Files:
- `test/helpers/hermetic-env.mjs` (mới), `package.json` script `test` thêm `--import ./test/helpers/hermetic-env.mjs`: đặt `ADA_SCAN_ROOT` = module root nếu chưa set, xoá `ADA_SCAN_*`, `CIS_*`, `SCAN_MODE` (OPS-3, TRC-25, FIX-38). Cite ✓ `trusted-deployment-url.js:25`, `utils/config.js:7-12`.
- `src/utils/config.js:7-12`: bỏ qua dotenv khi `ADA_SCAN_NO_DOTENV=1`. `trusted-deployment-url.js:25`: log một dòng khi env ghi đè `deploymentUrl` của config.
- `test/fix/candidate.test.js:478` ✓ (OPS-5): đọc `test/fixtures/header.liquid` thay vì `../src/partials/layout/header.liquid`.
- `test/accessscan-customer-a-reporting-copy.test.js:13` ✓ (OPS-6): fixture `docs/accessscan-customer-a-dom-scrape-demo.json` chưa từng vào git. Thay bằng fixture trung tính rút gọn trong `test/fixtures/`, đổi tên file test bỏ "customer-a".
- `test/helpers/require-browser.js` (mới, OPS-21): fail khi `CI` set, skip có thông báo khi local; thay 6 chỗ `t.skip` (`access-scan-tabs.test.js:14,46`, `access-scan-landmarks.test.js:14,50`, `access-scan-correctness.test.js:36`, `access-scan-contract-baseline.test.js:312`). `test/helpers/serve-html.js` (mới): http server nhỏ phục vụ map `{path: html}` cho test layer của 0.1/0.5a/0.9.
- `src/scanner/access-scan/signals/behavior.js:126` ✓ (comment chứa "parity", ACC-40): đổi chữ.
Acceptance: với `.env` thật của host vẫn tồn tại, các file attestation/controller/scan-target-audit 0 fail; test vocabulary (`access-scan-signal-policy-projection`) xanh; không còn `t.skip` vô điều kiện; fail còn lại chỉ thuộc corpus/workbench/flaky. Ghi `fails-after-0.8.txt`.
Risks: test nào ngầm dựa vào `.env` sẽ lộ ra, sửa từng cái. Hook chỉ set `ADA_SCAN_ROOT` khi chưa có để test tự đặt root không bị ghi đè.
Parallel: song song với 0.6, 0.10. `package.json` chung với 0.7: merge 0.8 trước.
Defer: OPS-22 (flaky, `--test-concurrency`) sang 1.11.

### 0.7 CI, package, ignore (S-M)
Files:
- Workflows: tạo `.github/workflows/test.yml`, `accessscan-corpus.yml`, `accessscan-drift.yml` trong module repo, bỏ `paths: 'ada-scan/**'` và `working-directory: ada-scan` ✓ (host `../.github/workflows/accessscan-corpus.yml:6,10` và `defaults.run`). Job `test`: `pnpm install --frozen-lockfile`, `playwright install chromium`, `pnpm test`, `continue-on-error: true` (DX-4); matrix Node theo D3. Thêm `.nvmrc` vào module.
- `package.json`: `private: true`, `packageManager`, `files` thêm `docs/` cho link README (CLI-29 phần package), `undici` theo D3 (OPS-19, OPS-20); commit `pnpm-lock.yaml`. Workflow đang pin pnpm 9, lock `lockfileVersion '9.0'`, máy dev dùng pnpm 11.26: giữ pnpm 9 trong CI cho khớp lock.
- `.gitignore` (OPS-30): `.tmp-*`, `test/.tmp-*`, `oracle-artifacts/`, `.tmp-drift-artifacts/`, `.pw.cjs`; xoá `.pw.cjs` và thư mục tạm; `test/helpers/accessscan-corpus-test-temp.js` dùng `os.tmpdir()`.
- `scripts/accessscan-corpus/run-drift-nonblocking.sh:27` ✓ (OPS-13): bỏ `set -e` thứ hai, `STDERR_RAW` vào `mktemp`, truyền path qua env thay vì nội suy vào JS.
- OPS-24: `scripts/accessscan-corpus/lib/dns-policy.js` `setDnsResolverForTests` xoá cache (file nằm trong `scripts/`, không phải `src/`).
- OPS-16: xoá `scripts/review-smoke.mjs`. OPS-17: xoá `scripts/cis-characterize.js`. Grep không còn tham chiếu trước khi xoá.
- OPS-33: điền `CHANGELOG.md [Unreleased]`. CLI-28: sửa comment `bin/ada-scan.js:2`.
Tests: sửa `test/accessscan-corpus-workflow.test.js` (OPS-23 phần nhỏ): `REPO_ROOT` trỏ module root, assert `working-directory` không còn `ada-scan`, path trong `paths` tồn tại.
Acceptance: `pnpm install --frozen-lockfile` thành công trên HEAD sạch; `git status` sạch sau chạy test; PR đầu tiên kích hoạt job `test`; `bash -n` và chạy `run-drift-nonblocking.sh /dev/null/x` vẫn exit 0.
Risks: undici 7 cần xác nhận API `Agent` (`test/fix/cis-transport.test.js:6`). Xoá workflow ở host nằm ngoài module, cần chủ host. Job corpus-verify đỏ tới khi D5 xong, giữ `continue-on-error`.
Parallel: chung `package.json` với 0.8 (merge sau 0.8), `dns-policy.js` với 0.4c (0.7 trước). Cô lập với scanner/fix.

### 0.1 Stop false-green (M)
Files:
- `src/index.js:1399-1415` ✓ (catch trả `scanFailed:true`), `:1435-1446` (`scanResults` map làm mất `scanFailed`), `:1513` ✓ (exit), `:1305-1312` ✓ (Lighthouse `info` bị `continue`).
- `src/scanner/browser.js` `resilientGoto` ✓ (không trả response); `src/scanner/w3c.js:271` ✓ (`W3C HTML validation passed`); `src/scanner/lighthouse.js:634-642` ✓ (`lighthouse-unavailable`, `impact:'info'`).
- `src/reporter/report-v2.js:277` `buildSummary` (+ `report-v2.d.ts`), `src/reporter/scan-report.js` `printConsoleSummary` (~:303).
Changes:
- CLI-1/RPT-2 (phần exit/summary): `scanResults` mang `scanFailed`/reason; `summary.pagesFailed`, `summary.scannerErrors` (đếm `scannerRuns` có `status` error/skipped/partial); console in "Incomplete scan: N page(s) failed"; `process.exitCode = 2` khi `pagesFailed>0` hoặc không layer nào `complete`; 2 thắng 1. Banner HTML để 1.7.
- SCN-1: `resilientGoto` trả `response`; trong `scanOnePage` (`index.js:~1020`, page chung) status >=400 hoặc challenge marker ("Just a moment", "Access Denied", chỉ kiểm khi status 403/429/503 hoặc body <5KB) thì throw `PageBlockedError` rơi vào catch hiện có. Bỏ qua khi `pageConfig.allowStatus` chứa status hoặc path `/404`, `/500` (DX-2). UA: bỏ `ADA-Scanner` và Chrome 120 giả (`browser.js:15`); chạy golden để chắc số không đổi.
- SCN-12: tách hàm thuần `interpretNuMessages(messages)` trong `w3c.js`; `non-document-error` thì `validationResult=null`, `status:'partial'`, không đẩy "passed".
- SCN-17: Lighthouse lỗi vào `scannerRuns` với `status:'error'` và `summary.scannerErrors`. Truyền `chromium.executablePath()` cho chrome-launcher (nếu rối thì để 1.8).
Tests (mới): `test/cli-incomplete-scan.test.js` (child process, URL `.invalid` và `serve-html` trả 404/500; assert exit 2 và `summary.pagesFailed`; `allowStatus` thì exit 0), `test/w3c-nu-messages.test.js` (pure), bổ sung `test/report-v2.test.js`.
Acceptance: DoD 1, 2; golden 58/79 không đổi; Lighthouse hỏng hiện trong summary.
Risks: (1) script dùng `--no-fail` kỳ vọng exit 0 sẽ thấy exit 2 khi dev server tắt (đúng ý, ghi CHANGELOG). (2) marker challenge có thể false positive (đã giới hạn điều kiện). (3) thêm field vào schema v2: cập nhật `validateScanReportV2` và `.d.ts` cùng lúc.
Parallel: không. `index.js`, `browser.js`, `w3c.js`, `report-v2.js` là điểm chung với 0.2, 0.5, 0.9. Đầu chuỗi scanner.

### 0.2 Config fail-closed (S)
Files: `src/utils/config.js:75-86` ✓ (`catch` trả default; `mergeConfig` ~:89-105), `src/utils/third-party.js:26-36` ✓ (`{...DEFAULT, ...(cfg.thirdParty||{})}`), `vite/scan-instrumentation.js:57-61` ✓ (`catch { return {} }`), `src/schema.js:26-35`, `src/index.js` (~:815-830 tên page, :700-716 cờ), `README.md` (bảng config).
Changes:
- CLI-6: parse lỗi thì throw `ConfigError` (exit 1 qua `bin/ada-scan.js`); file vắng thì giữ warn. Vite plugin cũng throw.
- CLI-5: `thirdParty` là mảng hoặc `null` thì tắt tường minh (`{selectors:[], devArtifactTokens:[], chatbotSelector:''}`); sửa README thành `{ "selectors": [] }`. Default Paradox giữ nguyên (D8 để sau).
- CLI-24: page thiếu `name` lấy slug từ path; trùng tên thì lỗi. CLI-32: `createViolation` ép `impact` ngoài enum về `moderate`, giữ giá trị gốc ở `evidence.originalImpact`.
- CLI-33 (phần cờ): include cùng exclude third-party thì lỗi; page `remote` lấy tên từ hostname+path. CLI-33 "load config một lần" **defer** (chạm `build-instrumented.js`, cache `third-party.js`, M). `validateConfig` đầy đủ là 1.1.
Tests: `test/config.test.js` (JSON hỏng throw, mảng thirdParty), `test/third-party.test.js`, `test/schema-impact.test.js` (mới), `test/scan-instrumentation-config.test.js` (mới).
Acceptance: DoD 3, 4; golden không đổi.
Risks: `.scan-config.json` của host hợp lệ nên không vỡ; plugin throw làm `pnpm build:vite` fail khi file hỏng (chủ ý).
Parallel: sau 0.1 (index.js). Độc lập với 0.3 nếu hunk khác nhau.

### 0.5 Chống mất scan (M, ba commit)
**0.5a scanner layers (S)**. Files: `src/scanner/aria-live.js:79-81,91-101` ✓ (`className.split`), `dynamic-content.js:88-93,241-247`, `browser.js:5-10` ✓, `w3c.js:275` ✓, `links.js:112-120` ✓ (HEAD only).
- SCN-7: `getAttribute('class')` + try/catch từng khối evaluate. SCN-8: try/catch từng `testX`, `click({timeout:3000})`. SCN-29: `CSS.escape`, bỏ `input[type=submit|button|image|reset]` khỏi form-label check.
- SCN-4: memoize `browserP`, relaunch khi `disconnected`. SCN-13: `page.context().close()`. SCN-42 (phần default timeout): `page.setDefaultTimeout(5000)` trong `newPage`; signal handler để 1.15.
- SCN-3 (có điều kiện): `waitUntil:'load'` + `waitForLoadState('networkidle',{timeout:10000}).catch(()=>{})`, bỏ goto lần hai. Chỉ giữ nếu golden vẫn 58/79; nếu hydrate muộn làm số đổi thì giữ `networkidle` và chỉ hạ timeout 60s xuống 20s (phần còn lại defer).
- SCN-5: HEAD trả 403/405/429/501/999 thì thử `GET` với `Range: bytes=0-0`; 401/403/429/999 sau retry là `unverifiable` (không violation); `clearTimeout` trong `finally`.
Tests: `test/scanner-resilience.test.js` (serve-html: SVG `icon-alert`, accordion ẩn, hai `getBrowser()` song song cùng instance, link 405).
**0.5b tracer/reporter (S-M)**. Files: `src/tracer/resolve-source.js:60-65,268-271` ✓ (+ `:279-326` shape), `src/scanner/keyboard.js:~280`, `screen-reader.js:~90`, `src/tracer/liquid-tag-index.js:104,402`, `src/reporter/report-v2.js:55-77,397` ✓, `:451,597-619`, `src/reporter/html.js:~580-591`, `src/reporter/scan-report.js:31-45` ✓ (`:39` ts).
- TRC-6: slice trước khi escape, `(?=[\s>/])` sau tên tag, try/catch tạo RegExp. TRC-7: export `toSource({originFile,originLine,...})`, dùng ở keyboard/screen-reader/resolve-source. TRC-14: chuẩn hoá `\\` trước khi check `..`; đọc file qua `readContainedSource` (đã có ở `remote-hint-trace.js:23-51`, chuyển ra util chung).
- RPT-6: `normalizeSource` hạ `high` thiếu file/line/preimage xuống `medium/none`, file chứa `..` thì null, thêm `diagnostics[]` (bounded); enum-check `impact` (coerce `moderate`); summary dùng `Map`; nếu build vẫn lỗi thì ghi `latest.invalid.json` kèm lỗi, không mất scan. RPT-14: `(element.outerHTML || '')`. RPT-10: ts mili-giây + 8 hex `reportId`, `latest.json` ghi tmp rồi `renameSync`. Retention **defer** 1.7.
Tests: `test/tracer-resolve-source-robust.test.js`, `test/report-v2-downgrade.test.js`, `test/scan-report-write.test.js` (hai lần ghi trong cùng giây ra hai thư mục).
**0.5c access-scan (S)**. Files: `src/scanner/access-scan/signals/semantics.js:145-157` (ACC-11), `signals/index.js:98-122` (ACC-1, ACC-2), `policies/accessscan.js:24-25` ✓ (`MODE_METRIC_KEYS`), `signals/types.js`.
- ACC-11: bỏ replace toàn cục theo value, escape tên thuộc tính. ACC-1: thêm `bottomAnchoredFootersScanned`. ACC-2: header chỉ đếm fact `geometry.top-anchored-header`.
Tests: `test/access-scan-redaction.test.js` (`data-token=""` không phá snippet); assert mọi value của `MODE_METRIC_KEYS` là key của `bundle.metrics`.
Acceptance (0.5): DoD 7, 8; golden 58/79; smoke layer không `skipped`.
Risks: ACC-1/2 đổi `candidateCount` nên `parity-metrics` corpus có thể lệch thêm (không được thêm case mới đỏ so với `verify.js` baseline 3 case). `diagnostics[]` đổi schema: cập nhật validate và `.d.ts`.
Parallel: 0.5c song song được với mọi thứ ngoài `access-scan/signals`; 0.5a và 0.5b sau 0.1.

### 0.3 Gate legacy fixer (S)
Files: `src/index.js:712` ✓ (`fixMode` default `'claude'`), `:1473-1500` (nhánh legacy `runFixEngine`), `src/fixer/engine.js:91-92` ✓ (`createRollbackPoint` + `rollback.save()` = `git stash`), `:104` ✓ (`rule.fix` luôn ghi, kể cả `--dry-run`), `:70-82` (IDE mode ghi file bất kể dryRun), `src/fixer/ui/server.js:39-46` ✓ (CORS `*`), `:157` ✓ (`listen(port)` không host), `:61` (thiếu `fix-dashboard.html`), `:136-141` (`/api/rollback` no-op), `src/fixer/presenter.js:46,98` (`import(./modes/${fixMode}.js)`), `src/utils/git.js:5-45`, `src/fixer/rollback.js:28,51`.
Changes:
- LEG-32: mặc định `fixMode='cis'`. Mode `claude` và `codex` (đường ghi trực tiếp) chỉ chạy với `--legacy-fix` + banner "legacy, deprecated". Mode `cursor|windsurf|vscode` (exporter, không chạy rule) chạy bình thường (D1).
- LEG-33: `--fix-mode` ngoài whitelist thì lỗi, liệt kê giá trị hợp lệ (chặn cả `../../x`).
- LEG-1: legacy + `--dry-run` thì refuse exit 1, không gọi `rule.fix`. LEG-28 (exporter bỏ qua dryRun) để 3.3 nhưng exporter không ghi khi `--dry-run` là thay đổi S: thêm guard nếu chạm cùng hunk.
- LEG-2/CLI-23/LEG-10/LEG-11: xoá `createRollbackPoint`/`rollback.save()` ở `engine.js:91-92`, xoá `gitStash`, `gitStashPop`, `hasGitRepo` nếu không còn caller (grep), `rollback.js` nếu rỗng.
- LEG-7: `listen(port, '127.0.0.1')`, bỏ `Access-Control-Allow-Origin: *`, từ chối request có `Origin` khác origin của server, `parseBody` yêu cầu `application/json`, thêm handler `'error'` cho `EADDRINUSE`. LEG-6: `/api/rollback` trả 501. LEG-8: `GET /` trả 501 kèm thông báo thay vì 500.
- Defer: LEG-3/LEG-5 (xoá path) sang 1.13, đã được chặn bởi `--legacy-fix`. LEG-12 (`[TODO]` placeholder) cũng chờ 1.13.
Tests (mới): `test/legacy-fix-gate.test.js` (hàm thuần `resolveFixMode(args)`; child process `--fix --dry-run --fix-mode claude` exit 1 và cây file không đổi; không có `git stash` được gọi), `test/fixer-ui-server.test.js` (địa chỉ `127.0.0.1`, `Origin` lạ bị từ chối, không có header CORS `*`).
Acceptance: DoD 5; `grep -rn "stash" src/` rỗng; exporter cursor vẫn ghi `.cursor/`.
Risks: người dùng quen `ada-scan --fix` (legacy) sẽ rơi vào CIS flow cần cấu hình CIS (ghi CHANGELOG, README đã gọi legacy là tạm thời); script host `scan:fix*` trỏ bản nhúng cũ nên không bị ảnh hưởng. `--fix` + `--ui` với legacy phải kèm `--legacy-fix`.
Parallel: song song với 0.6, 0.10, 0.5c. `src/index.js` chung với 0.1/0.2/0.4b/0.11/0.12 (hunk khác nhau, merge theo mục 6).

### 0.6 Verification trung thực (M, hai commit)
**0.6a verify gate (S-M)**. Files: `src/fix/verify/verification-key.js:90-107` ✓ (`isTargetResolved` trả `resolved:true` khi key vắng), `:121-134` (0 target = pass), `verify/shadow.js:177-178,407-408,420-423`, `verify/scanner.js:62-106,149-164,198`, `verify/post-apply-scan.js:73-99`, `verify/artifact.js:107,206`, `verify/site.js:15-30`, `controller/index.js:190-203,343`.
- FIX-4: `NO_TARGETS` khi `targetFindingIds` rỗng hoặc unit không tìm thấy.
- FIX-2: static adapter thử `p`, `p.html`, `p/index.html`; scanner (`scanner.js:149-164`) throw `ROUTE_NOT_OK` khi `!resp.ok()`.
- FIX-3 (bỏ claim): bỏ yêu cầu `sourceTraceResolved === true` ở `shadow.js:177-178,422`, `artifact.js:206`, `post-apply-scan.js:88-90`; ghi `sourceTrace:'not-verified'` thay cho `true` cố định. Không implement trace thật (2.x).
- FIX-1 (interim, DX-3): `compareVerificationFindings` nhận `scannedRoutes`; baseline có route không nằm trong tập đã scan thì `resolved:false, reason:'NOT_RESCANNED'`.
- FIX-24 (interim): `canGenerateProposal` (`policy/registry.js:121-123`) trả false cho `MECHANICALLY_SAFE` kèm reason code `NO_GENERATOR`; UI thôi đếm "proposable".
**0.6b apply/context (S)**. Files: `src/fix/apply/handler.js:113-138` ✓ (`postVerify` không try/catch), `context/broker.js:204-224` ✓ (`buildBindingMap` ghi sha256 đang có trên đĩa), `proposal/orchestrator.js:25-67,152-166`, `trace/inbox.js:92-125,275-282`, `policy/registry.js:70-90`, `canonical/fix-unit.js:94`.
- FIX-15: try/catch quanh `postVerify` (cả `signal.aborted`) thì `restoreTransactionFiles`, ghi journal `rollback`, ném `POST_VERIFY_ERROR`. Giữ lock qua post-verify (FIX-19) để 1.4.
- FIX-26: `buildBindingMap` so `binding.expectedSha256` với `opened.sha256`; `mapEditsFromCis` dùng preimage của trace chứ không tính lại từ đĩa.
- FIX-27: verify `preimageRange` bằng hash hoặc bỏ range, tính lại từ dòng đã verify, cap độ dài. FIX-28: `policy = min(descriptor, registry default)`, `fix.deterministic` cần generator đã đăng ký (cùng file `registry.js` với FIX-24, nên cùng PR). FIX-35: telemetry `proposed` sau khi `validateAndBuildCandidate` thành công; hash theo bytes.
Tests (mới): `test/fix/verify-gate-honesty.test.js` (route `/jobs` baseline, after-scan rỗng ⇒ không resolved; 0 target throw; clean-URL route; 404 throw), `test/fix/apply-postverify-rollback.test.js` (postVerify throw ⇒ file về nguyên trạng), `test/fix/context-broker-stale.test.js`, `test/fix/policy-ceiling.test.js`; sửa test cũ phụ thuộc `sourceTraceResolved` và test `canGenerateProposal`. Seed repro: `scratchpad/review/work/repro.mjs`, `cmp.mjs` (sao vào `test/fix/fixtures/` trước khi dùng vì scratchpad có thể mất).
Acceptance: các test trên xanh; toàn bộ `test/fix/*.test.js` không thêm fail mới; không còn "resolved" cho target chưa scan lại.
Risks: FIX-3 đổi schema artifact (field cũ) nên phiên cũ đã verify sẽ không đọc được, chấp nhận (chưa production). FIX-1 interim làm mọi fix cho route khác `/` không verify được cho tới 1.3. FIX-24 làm số "proposable" giảm.
Parallel: cả 0.6 độc lập với scanner/reporter, song song với 0.1-0.5, 0.8 (không chung file). Trong nội bộ: 0.6a và 0.6b không chung file (`registry.js` chỉ ở 0.6b); `FIX-15`, `FIX-19` cùng `handler.js`.

### 0.4 Security quick wins (M, ba commit)
**0.4a reporter escape (S-M)**. Files: `src/reporter/html.js:19-21` ✓ (`esc` thiếu `'`), `:108` (`impactBadge`), `:153,187` (double escape), `:297,301` ✓ (`onclick="switchDevice(..'${esc(pageName)}'..)"`), `:480-495` (`ruleId` vào href), `src/reporter/roi-doc.js:63,293-433` (chưa escape), `src/reporter/html-report.js` (383 dòng chết).
- RPT-1: `src/reporter/escape.js` (mới) `escapeHtml` có `'` và backtick; dùng ở html.js và roi-doc.js; thay `onclick` bằng `data-*` + `addEventListener`; `ruleId` qua `encodeURIComponent` + allow-list `/^[a-z0-9-]+$/` (ngoài allow-list thì không render link); enum-check `impact`/`layer`. CSP meta **defer** (cần chỉnh script inline, thêm rủi ro render).
- RPT-5: escape một lần ở sink. RPT-4: xoá `html-report.js` (grep import = 0).
Tests: `test/reporter-escape.test.js` (fixture hostile: page name, url, ruleId, impact, file, hint; assert không có `onerror=`/`<img` thô và không có `');alert`), bổ sung `test/reporter-html.test.js`.
**0.4b classifyHost (S-M)**. Files: `src/utils/host.js` (mới, `classifyHost(url)` dựa trên `new URL` + `net.BlockList`, trả `{kind:'loopback'|'private'|'public', ...}`, từ chối userinfo), callers: `src/index.js:766` (regex `isLocalUrl`), `src/fix/controller/mode-gate.js:5` ✓ (`LOCALHOST_PATTERN` coi `localhost:pw@evil` là local), `src/reporter/report-v2.js:50`, `src/scanner/lighthouse.js:512,572` (`includes('localhost')`, `isLocal`), `src/fix/cis/transport.js:18` ✓ (`::1` vs `[::1]`), `src/fix/cis/config.js:42`, `src/fix/cis/tls-mode.js:87`.
- CLI-9/FIX-31/RPT-22/SCN-14/CIS-27: một helper. `isLocalUrl` (kích hoạt build instrumented) = loopback (`localhost`, `*.localhost`, `127/8`, `::1`, `0.0.0.0`); `private` chỉ dùng để chặn egress (PSI/W3C) và dev-mode của Lighthouse. SCN-14 `GOOGLE_API_KEY` chuyển sang header `X-goog-api-key` (`lighthouse.js:434`). Không đổi default egress (D2).
Tests: `test/host-classify.test.js` (`localhost.evil.com`, `localhost:pw@evil.example`, `[::1]`, `0.0.0.0`, `foo.localhost`, `192.168.1.5`, `10.0.0.1`), bổ sung `test/fix/mode-gate.test.js`.
**0.4c CIS server và corpus tooling (S)**. Files: `src/fix/review/server.js:78` ✓ (key `APPLY_STARTED` trùng, giá trị cuối thắng), `:593-604` ✓ (listen rồi mới persist, rò socket), `:346-366` + `readJsonBody` (body `null` ra 500), `src/fix/review/workbench.html:537` ✓ (`a.href = unit.editorLink` không qua `safeEditorHref`), `scripts/accessscan-corpus/lib/dns-policy.js:85` ✓ (chỉ `fe80:`), `scripts/accessscan-corpus/capture.js:66-76` ✓ (`--url` không guard).
- CIS-11: xoá dòng 78. CIS-22: persist trước listen hoặc try/catch `server.close()`. CIS-23: `readJsonBody` chỉ nhận object thường, bọc state call bằng một `handle(res, fn)`. CIS-34: bọc `safeEditorHref`. OPS-7: `isPrivateOrReservedIpAddress` dùng `net.BlockList` (loopback, `fe80::/10`, `fc00::/7`, `fec0::/10`, `64:ff9b::/96`, `2002::/16`, `::ffff:0:0/96`, các dải IPv4 reserved: `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`). OPS-8: `capture.js` gọi `assertSafeSourceNavigationUrl` + `installCorpusPageAndContextGuards` trước capture. OPS-9 (rebinding) không thuộc Wave 0.
Tests: `test/dns-policy-ranges.test.js` (bảng địa chỉ đã probe: `0::1`, `fe90::1`, `febf::1`, `fec0::1`, `64:ff9b::7f00:1`, `2002:7f00:1::`, `192.0.2.1`, `198.18.0.1`, `203.0.113.5`), `test/fix/review-server-hardening.test.js` (body `null`, dupe key, `listen` lỗi).
Defer khỏi 0.4: CIS-22 phần "persist trước listen" nếu đụng `startReviewServer` nhiều; CIS-21/20 (token, Host header) sang 1.6; OPS-10 (id mờ khách hàng, M) sang 1.11.
Acceptance (0.4): DoD 6; `grep -rn "html-report" src` rỗng; golden không đổi; test classifyHost xanh.
Risks: escape sai làm hỏng markup báo cáo (so sánh ảnh chụp `scan-visual.html` trước/sau bằng mắt trên golden). `isLocalUrl` đổi nên `0.0.0.0`/`[::1]` giờ kích hoạt build local (chủ ý). BlockList làm host hợp lệ bị chặn nếu AAAA thuộc dải lạ; chấp nhận (fail-closed).
Parallel: 0.4a chung `html.js` với 0.5b và 0.11 (0.5b → 0.4a → 0.11); 0.4b chạm `index.js`, `report-v2.js` (sau 0.1, 0.5b); 0.4c độc lập, song song được, chỉ cần sau 0.7 vì `dns-policy.js`.

### 0.9 Scanner layers, fix S (M)
Files: `src/scanner/focus-trap.js:75,111` ✓ (selector `.first()` dùng chung), `:57,120,128,175` ✓ (`offsetParent`), `src/scanner/keyboard.js:113,154,169,227`, `src/scanner/screen-reader.js:310-341,357-367,639-671`, `src/scanner/w3c.js:~214` (wcag 4.1.1).
- SCN-9: `locator(selector).nth(i)`, dedupe phần tử qua nhiều selector, ưu tiên `aria-haspopup=dialog`/`data-modal-trigger`, gắn selector duy nhất vào violation (giữ cap 3 + time budget sau). SCN-10: `checkVisibility({checkVisibilityCSS:true})` và diff dialog trước/sau click.
- SCN-20 (phần S): `rect.top + scrollY`, fingerprint dùng toạ độ trang. **Defer** phần so DOM order với tab order (M).
- SCN-24: loại phần tử focusable (skip link) và nhánh SVG `display:none/visibility:hidden`. SCN-25: bỏ qua `role=presentation|none`, bỏ `th-no-scope`. SCN-26: đếm trước rồi `slice` làm ví dụ, regex filename `/\.(jpe?g|png|gif|svg|webp)$/i`, bỏ nhánh `empty-in-link` khi link đã có tên khác.
- SCN-37 (phần S): gắn `best-practice` thay vì `4.1.1`. **Defer** validate HTML thô (M).
Tests (mới, dùng `serve-html` và probe HTML trong `scratchpad/review/probe.mjs`, `p3.mjs` sao thành fixture): `test/scanner-focus-trap.test.js` (hai trigger cho hai kết quả khác nhau; modal fixed bỏ qua Escape thì fail), `test/scanner-keyboard.test.js`, `test/scanner-screen-reader.test.js` (skip link và layout table không bị flag).
Acceptance: smoke layer không `skipped`; golden 58/79 (axe, accessScan không chạm). Số finding của 6 layer behavioral đổi theo thiết kế: ghi diff ruleId vào PR.
Risks: SCN-10 làm lộ thêm finding thật (Escape không đóng modal); SCN-24/25 giảm noise. Đây là đổi số liệu có chủ ý nên không dùng làm gate regression.
Parallel: sau 0.1 và 0.5a (`w3c.js`, `browser.js`), sau 0.5b (`keyboard.js:280`, `screen-reader.js:90`). Có thể chạy song song với 0.10, 0.6, 0.3.

### 0.10 access-scan rule correctness S (M)
Files (đều trong `src/scanner/access-scan/`): `rules/interactive.rules.js:48` ✓ (`a[href^="#"]`, ACC-10), `evaluators/geometry.evaluator.js:21-30,79-86` (ACC-14), `dragging.evaluator.js:62-102` (ACC-15), `list-structure.evaluator.js:19-24` (ACC-16), `document-metadata.evaluator.js` (ACC-17), `attributes-roles.evaluator.js:86-96,133-146` (ACC-18, ACC-19), `graphics.evaluator.js:27-58` (ACC-20), `semantic-style.evaluator.js:62-99,241-276` (ACC-22).
- ACC-10: `LinkAnchorDiscernible` nhắm `a[href]` (không đụng selector engine `graph-query.js:185-190`). ACC-14: xoá `passesInlineSpacingException`. ACC-15: tìm container từ `parent`, từ khoá theo word boundary. ACC-16: nhận `role=listitem`, bỏ qua `role=none/presentation`; slotted **defer** (ACC-28).
- ACC-17: parse `content` của `meta refresh` (delay/url), viewport không phân biệt hoa thường, `HtmlLangValid` dùng `Intl.getCanonicalLocales`, `PageTitleDescriptive` không báo đôi khi `PageTitle` đã báo. ACC-18: nhận `aria-label`/`aria-labelledby`. ACC-19: loại `aria-haspopup="false"`, tin `element.focusable`. ACC-20: nhận `aria-label`, `aria-labelledby`, `title`, `role=none`; phần "icon không role" ở standards path **defer** (ACC-8/7 mô hình tên). ACC-22: loại phần tử focusable và sr-only khỏi `VisibilityMisuse`.
Tests (mới): `test/access-scan-rules-wave0.test.js` (mỗi ID một cặp HTML dương/âm, lấy từ probe trong báo cáo). Cập nhật expectation corpus bằng reseed khi D5 chốt.
Acceptance: test mới xanh; `access-scan-*.test.js` hiện có không thêm fail; golden preview chạy lại, diff ruleId giải thích được (kỳ vọng thêm `LinkAnchorDiscernible` cho link nội dung không tên, bớt `VisibilityMisuse`); `node scripts/accessscan-corpus/verify.js` không có case đỏ mới ngoài 124/203/731 (nếu có, reseed theo D5 trong commit riêng, CHANGELOG ghi "public contract").
Risks: đổi số liệu và hash corpus (hợp đồng công khai theo CHANGELOG); ACC-10 làm tăng finding trên mọi site có icon link; 0.10 phải đi sau D5/P1 để không trộn hai nguồn lệch.
Parallel: song song với 0.3, 0.6, 0.8, 0.9; chỉ chung file với 0.12 (ACC-32 xoá `graphics.evaluator.js` mode dead): 0.10 trước.

### 0.11 Tracer và reporter S (S-M)
Files: `src/tracer/deployment-url.js:15-18` ✓ (`parsed.hash`/`parsed.search` làm false cả URL đã scan), `page-attestation.js:157,223`, `src/tracer/trusted-deployment-url.js:31-73`, `src/fix/controller/mode-gate.js:~90,115`, `src/tracer/attestation-reasons.js:10,14,29-34`, `src/index.js:~495-545` (`resolveMissingLines`), `src/tracer/build-instrumented.js:58-63`, `src/reporter/roi-doc.js:129-305` ✓ (`manualStepsAutomated = 4`, `automationCoverage = '75–80'`), `src/reporter/html.js:480,827`.
- TRC-1: tách `isBoundedHttpUrl` strict cho deployment URL (`canonicalizeDeploymentUrl`) và kiểm scope của URL đã scan chỉ theo origin + path prefix. TRC-4: emitter dùng đúng tên enum (`MISSING_DEPLOYMENT_URL`, `MISSING_INSTRUMENTATION_DIGEST`); `sanitizeAttestationReason` log khi gặp giá trị lạ thay vì quy về `REMOTE_ATTESTATION_INVALID`; test mọi literal `reason:` thuộc enum.
- TRC-16: khi đổi file/line thì xoá `preimageSha256/preimageRange` cũ và `confidence = min(existing, hit)`, hạ `medium` khi `hit.ambiguous`. TRC-17: `git status --porcelain=v1 --untracked-files=no`.
- RPT-13: xoá số hardcode (75-80%, ring 78/100/100/80, phần trăm theo category, "Baseline violations (manual)"), chỉ hiện số đo được (D10); tính từ run metadata để 1.7. RPT-15: hiện page name/URL (đã escape) trên card. RPT-21: link Deque lấy `major.minor` từ `axe-core/package.json`, `toLocaleString` thay bằng ISO UTC.
Tests: bổ sung `test/tracing-attestation.test.js` (URL `?page=2`, `#r` vẫn trong scope), `test/reporter-roi-doc.test.js` (mới: không còn chuỗi `75`), `test/tracer-reasons.test.js` (mới).
Acceptance: golden không đổi số; hybrid không bị tắt cho URL có query.
Risks: nới scope của URL đã scan là thay đổi trust boundary: giữ so khớp origin + path prefix, vẫn cấm userinfo; review kỹ bởi advisor. RPT-13 xoá bớt nội dung ROI mà lãnh đạo đã quen.
Parallel: sau 0.4a (`html.js`, `roi-doc.js`), sau 0.1/0.4b (`index.js`, `mode-gate.js`).

### 0.12 Dead code và docs (S-M, hai commit)
**0.12a không đổi hành vi**. CLI-31 (`utils/logger.js`, helper `schema.js` không dùng, import `loadBaseline` `index.js:35`, `gitDiffFiles`, `hasUncommittedChanges`), SCN-40, ACC-32 (`tab-graph.evaluator.js` `getDirectChildren`, mode `icon-discernible`, mode `visibility-mismatch` và helper), CIS-39 (`state.js` `findingOwnerMap`, `markApplyStarted`, `effective-units.js` `effectiveUnitById`, `advisory.js evaluateAdvisoryBudgets` hoặc nối vào, `limits.js maxConcurrency`), LEG-9 (xoá `src/fixer/agent.js`, 0 caller; không phụ thuộc D1), OPS-26 (bỏ số test "851/851" ở `README.md:356`, `docs/cis-contract.md:29-30`), OPS-29 (cập nhật bảng trạng thái `docs/fix-ada-cis-design-plan.md`), CLI-29 (README: "Four layers" thành 10, `--all`, flag thiếu, `cd ada-scan`, dời host nội bộ).
Quy trình xoá: grep tên trước (dùng `mcp codegraph impact` hoặc `grep -rn`), xoá, `node --check` và `node -e "import('./src/index.js')"`, rồi full suite so `fails-*.txt`.
**0.12b hành vi nhỏ**. CLI-26 (`src/index.js:933` ✓ cursor-up ANSI chỉ khi `process.stdout.isTTY` và không `CI`), CLI-27 (`bin/ada-scan.js:27-30` in `err.code`, stack khi `--verbose`/`DEBUG`, gợi ý `npx playwright install chromium`, dùng `process.exitCode`), CIS-24 (`telemetry.js:16` ✓ enforce `MAX_FILE_BYTES`, đọc bỏ qua dòng hỏng).
Tests: `test/cli-output.test.js` (mới: non-TTY không có `\x1b[`), `test/fix/cis-telemetry.test.js` bổ sung.
Acceptance: full suite không thêm fail; `git diff --stat` chỉ xoá; golden không đổi.
Risks: "không dùng" có thể sai với import động (`import(\`./modes/${m}.js\``) và test: grep cả `test/`, `scripts/`, `vite/`.
Parallel: cuối chuỗi, chung file với 0.3 (`utils/git.js`), 0.9 (`screen-reader.js`), 0.10 (`graphics.evaluator.js`).

## 6. Xung đột giữa bundle và thứ tự merge

| File | Bundle chạm | Ghi chú |
|---|---|---|
| `src/index.js` | 0.1 (~1305,1399-1446,1513), 0.2 (~700-716,815-830), 0.3 (712,1473-1500), 0.4b (766), 0.11 (~495-545), 0.12 (35,933) | hunk tách rời; rebase từng PR lên `main` mới nhất |
| `src/scanner/browser.js` | 0.1 (goto, UA), 0.5a (memoize, timeout) | 0.1 trước |
| `src/scanner/w3c.js` | 0.1 (SCN-12), 0.5a (SCN-13), 0.9 (SCN-37) | 0.1 → 0.5a → 0.9 |
| `src/scanner/lighthouse.js` | 0.1 (SCN-17), 0.4b (isLocal, key) | 0.1 → 0.4b |
| `src/scanner/keyboard.js`, `screen-reader.js` | 0.5b (`toSource`), 0.9, 0.12 | 0.5b → 0.9 → 0.12 |
| `src/reporter/report-v2.js` | 0.1 (summary), 0.4b (`inferTargetMode`), 0.5b (normalize/validate) | 0.1 → 0.5b → 0.4b |
| `src/reporter/scan-report.js` | 0.1 (console), 0.5b (write) | 0.1 → 0.5b |
| `src/reporter/html.js` | 0.4a, 0.5b (RPT-14), 0.11 (RPT-15, RPT-21 cùng vùng `:480` với RPT-1) | 0.5b → 0.4a → 0.11 |
| `src/reporter/roi-doc.js` | 0.4a, 0.11 | 0.4a → 0.11 |
| `src/fix/controller/mode-gate.js` | 0.4b (FIX-31), 0.11 (TRC-4) | 0.4b → 0.11 |
| `src/fix/review/server.js`, `workbench.html` | 0.4c, 0.12 (CIS-39 ở `state.js`) | độc lập |
| `package.json` | 0.8, 0.7 | 0.8 → 0.7 |
| `src/utils/git.js`, `src/fixer/*` | 0.3, 0.12 | 0.3 → 0.12 |
| `access-scan/evaluators/graphics.evaluator.js` | 0.10, 0.12 | 0.10 → 0.12 |
| `scripts/accessscan-corpus/lib/dns-policy.js` | 0.7 (OPS-24), 0.4c (OPS-7) | 0.7 → 0.4c |
| `src/fix/policy/registry.js` | 0.6b (FIX-24, FIX-28) | cùng PR |

Merge order (trunk): 0.8 → 0.7 → 0.1 → 0.2 → 0.5a → 0.5b → 0.5c → 0.3 → 0.6a → 0.6b → 0.4b → 0.4a → 0.4c → 0.9 → 0.10 → 0.11 → 0.12a → 0.12b. Mỗi PR rebase lên `main`, chạy lại test file bị chạm và golden nếu bundle nằm trong DoD 10.

## 7. Rollout, kiểm chứng và rủi ro

### 7.1 Checklist sau khi xong tất cả bundle
1. `git status` sạch; `git log --oneline wave0-base..HEAD` mỗi bundle một commit (hoặc một PR).
2. Full suite hai lần liên tiếp (kiểm flaky), có `.env` host: `export ADA_SCAN_ROOT=$PWD; node --test test/*.test.js test/fix/*.test.js`. Kỳ vọng: không fail env/host/fixture; fail còn lại ⊂ {corpus 124/203/731 nếu D5 chưa xong, workbench 7, flaky <=2}. So `fails-base.txt`: không có test mới đỏ.
3. Node theo D3: chạy lại `test/fix/cis-*.test.js` và `test/build-instrumented-spawn.test.js` trên Node 20.18.1 (hoặc xem CI matrix).
4. `node scripts/accessscan-corpus/verify.js`: ghi kết quả (đỏ chỉ ở case đã giải thích bằng D5).
5. DoD 1, 2: hai lệnh repro exit 2 (`$G` mới, so với baseline exit 0).
6. Golden preview exclude/include: 58/79 nếu không có 0.9/0.10; nếu có, kèm bảng diff ruleId. So `summary` bằng `node -e` ở mục 2.6.
7. Golden local `:1234` (có backup/restore): xong thì `git -C $HOST status --short` giống `host-status.before`; không còn log `postinstall` lồng (NEW-1 vẫn ổn).
8. Smoke layer: `--layers links,keyboard,focusTrap,ariaLive,dynamicContent,screenReader,w3c` trên preview: không layer nào `skipped`/`error` trong `scannerRuns`.
9. `--fix --dry-run --fix-mode claude` exit 1; `--fix-mode cursor --dry-run` không ghi `.cursor/`.
10. Mở `scan-visual.html` và `roi-technical.html` của golden: render đúng, không còn "75–80%".
11. `CHANGELOG [Unreleased]` đủ mục; CI xanh hoặc đỏ chỉ ở nhóm đã biết; advisor review diff cuối (gate 3).

### 7.2 Risk register
| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R1 | SCN-1 chặn nhầm trang hợp lệ trả 404/500 (site Paradox có `/404`, `/500`) | cao | `allowStatus`, auto-allow hai path, test |
| R2 | Exit 2 làm vỡ script/CI đang dùng `--no-fail` | trung | CHANGELOG, `--allow-incomplete`, D4 chốt trước |
| R3 | SCN-3 đổi timing hydrate làm số golden dịch | trung | giữ cổng golden; phương án lùi: chỉ hạ timeout |
| R4 | 0.10 đổi hash corpus (hợp đồng công khai) | cao | P1 bisect, reseed commit riêng, CHANGELOG |
| R5 | `--fix` đổi mặc định sang `cis` | trung | banner, README, giữ exporter cursor |
| R6 | D3 hạ undici 7 chưa chạy thử; hoặc nâng 22 phá môi trường host | trung | thử `pnpm add undici@^7` + `cis-*.test.js`; CI matrix |
| R7 | Xoá "dead code" sai (import động) | thấp | grep cả test/scripts/vite, full suite |
| R8 | Golden preview là staging sống, nội dung đổi | trung | re-baseline khi lệch >2 trước khi sửa; lưu `latest.json` mỗi tag |
| R9 | FIX-1 interim fail-closed làm fix route khác `/` không verify được | thấp | chấp nhận tới 1.3, ghi README |
| R10 | Cặp worktree chạy song song gây conflict `index.js` | trung | thứ tự merge mục 6, rebase thường xuyên |
| R11 | Scan golden local ghi đè `scan-reports/` và `dist/` của host (NEW-4) | trung | backup/restore mục 2.6; đề xuất `ADA_SCAN_REPORTS_DIR` ở mục 9 |

## 8. Đề xuất chạy song song (worktree)

Tạo worktree: `git worktree add ../ada-wt-<tag> -b wave0/<id>-<slug> main`. Mỗi session chỉ làm các bundle trong cùng hàng, theo thứ tự.

| Session | Bundle (thứ tự) | File tập trung | Chạm chung với session khác |
|---|---|---|---|
| S1 | 0.8 → 0.7 | `test/helpers`, `package.json`, `.github`, `scripts/` | `package.json` (nội bộ), `dns-policy.js` (S5) |
| S2 | 0.6a → 0.6b | `src/fix/{verify,apply,context,proposal,trace,policy,canonical}` | không có |
| S3 | 0.10 → 0.5c | `src/scanner/access-scan/**` | không có (0.12 sau) |
| S4 | 0.3 | `src/fixer/**`, `utils/git.js`, hunk nhỏ `index.js` | `index.js` |
| S5 | 0.1 → 0.2 → 0.5a → 0.5b → 0.9 | scanner layers, `index.js`, reporter | trục chính; làm tuần tự |
| S6 | 0.4c | `src/fix/review/server.js`, `workbench.html`, `scripts/accessscan-corpus` | sau S1 (`dns-policy.js`) |
Sau khi S1-S6 merge: 0.4b → 0.4a → 0.11 → 0.12 làm tuần tự (chung `index.js`, `html.js`, `mode-gate.js`).
Song song an toàn ngay từ đầu (không chung file): S1 (phần 0.8), S2, S3, S4. S5 cần 0.8 (helper `requireBrowser`, `serve-html`) merge trước khi viết test browser; có thể bắt đầu code song song và rebase sau.
Không song song: 0.1/0.2/0.5/0.9 (chung `index.js`, `browser.js`, `w3c.js`); 0.4a/0.5b/0.11 (chung `html.js`).
Mỗi session độc lập chạy test file riêng và golden với `G` riêng (`$HOME/ada-scan-golden/<session>`); chỉ một session được chạy golden local `:1234` tại một thời điểm (dùng chung `dist/` và `scan-reports/` của host).

## 9. Phụ lục

### 9.1 ID đề xuất defer khỏi Wave 0 (không thực sự S hoặc rủi ro)
| ID | Lý do | Đi đâu |
|---|---|---|
| FIX-1 (bản đầy đủ) | M: truyền routes/layers xuyên pipeline; Wave 0 chỉ fail-closed | 1.3 |
| FIX-3 (implement thật), FIX-24 (generator thật) | M-L | 2.4, 3.2 |
| CLI-33 "load config một lần" | chạm `build-instrumented.js`, cache third-party | 1.2 |
| SCN-20 (DOM order vs tab order) | M | 1.8 |
| SCN-37 (validate HTML thô) | S-M, đổi nguồn input | 1.8 |
| ACC-16 slotted, ACC-20 "icon không role" | cần mô hình tên/slot (ACC-7, ACC-28) | 2.1, 2.2 |
| RPT-1 CSP meta | sửa script inline, rủi ro render | 1.7 |
| RPT-10 retention | không cần cho an toàn dữ liệu | 1.7 |
| SCN-3 (nếu golden dịch) | đổi timing hydrate | 1.8 |
| SCN-17 chrome-launcher dùng Chromium của Playwright (nếu rối) | | 1.8 |
| OPS-9, OPS-10, OPS-22, OPS-2 reseed (nếu D5 chưa chốt) | M | 1.11 |
Tổng defer: 12 ID/phần (FIX-1 đầy đủ, FIX-3, FIX-24, CLI-33 phần, SCN-20 phần, SCN-37 phần, ACC-16 phần, ACC-20 phần, RPT-1 CSP, RPT-10 phần, SCN-3 có điều kiện, SCN-17 phần).

### 9.2 P0 của mục 3 chưa nằm trong Wave 0
CIS-5, CIS-6 (S, có thể kéo lên làm bundle riêng nếu muốn), CIS-1/2, FIX-16, CIS-10/OPS-4, OPS-2, OPS-10, LEG-3/LEG-5 (đã bị chặn gián tiếp bởi `--legacy-fix`). Tất cả nằm ở Wave 1 theo bảng review.

### 9.3 Ngoài 12 bundle, đề xuất thêm (không bắt buộc)
- NEW-4 (S-M): `ADA_SCAN_REPORTS_DIR` đọc lazy qua một `getReportsDir()` thay cho 4 hằng `REPORTS_DIR` (`scan-report.js:7`, `html.js:8`, `roi-doc.js:6`, `index.js:659,750`); thêm sau 0.12 để golden local khỏi phải backup.
- NEW-2: cảnh báo một dòng khi chỉ scan 1 page vì `pages: []` (S); resolver page đầy đủ là Wave riêng (A.4).
- Advisor gate: trước khi khoá plan, sau mỗi bundle chạm gate/security (0.1, 0.3, 0.4, 0.6, 0.11), và trước khi đóng Wave 0.
