# rule

个人分流规则仓库：通过 [merge.yaml](merge.yaml) 聚合上游 Surge 规则，生成分类 TXT 文件；同时提供将部分 TXT 转换为 sing-box JSON / SRS 规则集的工具。

## 规则列表

| 文件 | 用途与来源 | 订阅链接 |
| --- | --- | --- |
| [fix.txt](fix.txt) | 直连修正，来自 RuleGo 的 Direct+ | [Raw](https://raw.githubusercontent.com/Lc1fer/rule/main/fix.txt) |
| [reject.txt](reject.txt) | 广告与追踪拦截 | [Raw](https://raw.githubusercontent.com/Lc1fer/rule/main/reject.txt) |
| [us.txt](us.txt) | OpenAI、Anthropic 等 AI 服务，便于单独指定策略 | [Raw](https://raw.githubusercontent.com/Lc1fer/rule/main/us.txt) |
| [proxy.txt](proxy.txt) | 代理与境外流媒体规则 | [Raw](https://raw.githubusercontent.com/Lc1fer/rule/main/proxy.txt) |
| [direct.txt](direct.txt) | 直连规则，合并 Apple、ByteDance、Speedtest 及本仓库 LAN 规则 | [Raw](https://raw.githubusercontent.com/Lc1fer/rule/main/direct.txt) |
| [lan.txt](lan.txt) | 本地维护的 IPv4 / IPv6 局域网及保留地址段 | [Raw](https://raw.githubusercontent.com/Lc1fer/rule/main/lan.txt) |

TXT 文件只包含匹配规则，实际直连、代理或拦截行为由客户端指定的策略决定。`us.txt` 是分类名称，使用时需自行选择适合的节点或策略组。

## 自定义来源与规则

编辑 `merge.yaml`，分类名称对应输出文件名。下面展示如何为现有的 `direct` 分类添加和移除规则；合并到原有配置时应保留需要的上游 URL：

```yaml
direct:
  url:
    - https://raw.githubusercontent.com/ConnersHua/RuleGo/master/Surge/Ruleset/Direct.list
  rules:
    add:
      - DOMAIN-SUFFIX,example.com
    remove:
      - DOMAIN,remove.example.com
```

- 配置只支持脚本定义的 YAML 子集：`分类 → url / rules → add / remove`。使用空格缩进、无引号的单行值，注释放在独立行。
- 合并时忽略空行和以 `#` 开头的整行注释，按完整规则行去重并排序；`remove` 最后执行，按完整规则行精确移除。
- 规则集合没有变化时保留原文件及更新时间；有变化时写入北京时间的更新时间。
- 同一来源在一次运行中只下载一次，最多并发下载 4 个来源；每个来源最多尝试 3 次，每次超时 60 秒。
- 某分类的任一来源下载失败时保留该分类原文件，其他分类继续生成，脚本最终返回失败状态。
- 未配置来源和新增规则的分类会跳过；应用移除规则前若合并结果为空，也会保留原文件。
- 自动清理默认关闭，因此 `lan.txt` 等未作为输出分类的 TXT 文件会保留。`lan.txt` 通过远程 URL 合入 `direct`，本地修改后需先推送，才能被默认配置下载到。

## 转换为 sing-box JSON / SRS

[转换脚本](script/convert_txt_to_json.py) 仅依赖 Python 3 标准库，不需要安装 sing-box 或第三方 Python 包。可使用 Python 3.13，与工作流模板保持一致。

```bash
python3 script/convert_txt_to_json.py --skip-unsupported-type USER-AGENT
```

默认读取根目录的 `direct.txt`、`fix.txt`、`proxy.txt`、`reject.txt`，生成同名的 4 份 `.json` 和 4 份 `.srs` 文件，格式版本均为 1。`us.txt` 和 `lan.txt` 不在默认转换范围内。

也可以指定输入和输出目录，例如将生成结果写入单独的目录：

```bash
python3 script/convert_txt_to_json.py \
  --rule-dir . \
  --output-dir ./output \
  --skip-unsupported-type USER-AGENT
```

转换行为：

- 支持 `DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`IP-CIDR`、`IP-CIDR6` 和 `PROCESS-NAME`。
- 现有 TXT 包含 `USER-AGENT`，sing-box 没有对应字段，因此示例显式跳过，并在日志中报告数量；不加该选项会报错。
- `GEOIP` 仅保留在 TXT 中，转换时省略，因此转换后的规则与原始 TXT 存在匹配范围差异。
- 进程规则与域名 / IP 规则分组为或关系；IP 网段会规范化，重复项按首次出现顺序去重。
- 全部输入校验及编码成功、输出预检通过后才发布结果；内容未变化时保留输出文件及修改时间。实际替换阶段的文件系统错误不会回滚已完成的替换。

更多细节见 [TXT 转 JSON / SRS](script/convert_txt_to_json.md)。

## GitHub Actions

### 已启用：Merge Rules

工作流位于 [.github/workflows/merge-rules.yml](.github/workflows/merge-rules.yml)：

- 每天北京时间 **06:30** 定时执行（UTC `30 22 * * *`，实际启动时间可能有延迟）。
- 支持在 Actions 页面手动运行。
- 推送到 `main` 且修改 `merge.yaml`、`script/merge-rules.js` 或该工作流文件时触发。
- 使用 Node.js 24 生成规则，仅提交根目录有变化的 TXT 文件。
- 下载部分失败时仍尝试提交其他分类的更新，随后将工作流标记为失败。

### 可选模板：TXT-JSON-Binary

[script/txt-json-binary.yml](script/txt-json-binary.yml) 当前只是模板，尚未放入 `.github/workflows/`，不会自动运行。需要启用时：

```bash
cp script/txt-json-binary.yml .github/workflows/txt-json-binary.yml
```

提交该工作流后，可手动运行或在匹配的 TXT、转换脚本及工作流文件推送到 `main` 时触发。模板使用 Python 3.13，检查八份输出均已生成且非空后，一起提交 JSON / SRS 文件。运行时需要仓库内容写入权限。

由其他工作流使用默认 `GITHUB_TOKEN` 推送的提交通常不会触发后续 push 工作流；如需在定时合并后执行转换，可在合并流程中增加转换步骤或配置独立触发方式。

## 仓库结构

```text
.
├── .github/workflows/merge-rules.yml  # 已启用的规则合并工作流
├── merge.yaml                       # 上游来源与自定义规则
├── direct.txt / fix.txt / proxy.txt / reject.txt / us.txt
├── lan.txt                          # 本地维护的 LAN / 保留地址规则
└── script/
    ├── merge-rules.js                # 下载、合并并生成 TXT
    ├── convert_txt_to_json.py        # TXT 转 JSON / SRS
    ├── convert_txt_to_json.md        # 转换脚本详细说明
    ├── txt-json-binary.yml           # 转换工作流模板
    └── boxjs.json                   # yuheng 脚本的 BoxJS 订阅配置
```

## 来源与致谢

- [ConnersHua/RuleGo](https://github.com/ConnersHua/RuleGo)：直连修正、广告与追踪拦截、AI 服务、代理、流媒体及 Apple 等规则。
- [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)：ByteDance、Speedtest 规则。
- [Yuheng0101/X](https://github.com/Yuheng0101/X)：`script/boxjs.json` 所引用的脚本与订阅信息。

具体规则来源以 [merge.yaml](merge.yaml) 为准；上游内容及相关使用要求请参阅各来源项目。
