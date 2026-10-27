# 控制台路由表（自动生成，勿手改）

> 由 `node scripts/gen-route-index.mjs` 生成；顺序 = `server.js` 的 `ROUTE_CHAIN` 顺序，
> 即真实分发顺序（前面的 handler 先拿到请求）。`ANY` = 该行未显式判断方法（多为只读）。
> 守卫：`check:route-index`（selfcheck 里跑），路由改了忘了重新生成就红。

## handleConsoleHome（1 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/` | src/console/routes/admin.js:62 |

## handleRoleModeRoutes（7 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/status` | src/console/routes/role.js:61 |
| GET | `/api/presets` | src/console/routes/role.js:81 |
| POST | `/api/mode` | src/console/routes/role.js:94 |
| POST | `/api/role` | src/console/routes/role.js:129 |
| POST | `/api/role-mode` | src/console/routes/role.js:153 |
| GET | `/api/roles` | src/console/routes/role.js:167 |
| POST | `/api/roles/create` | src/console/routes/role.js:176 |

## handleSlangAdminRoutes（9 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/slang` | src/console/routes/slang.js:127 |
| POST | `/api/slang` | src/console/routes/slang.js:137 |
| POST | `/api/slang/clear` | src/console/routes/slang.js:163 |
| POST | `/api/slang/batch-delete` | src/console/routes/slang.js:192 |
| POST | `/api/slang/extract` | src/console/routes/slang.js:223 |
| POST | `/api/slang/research` | src/console/routes/slang.js:242 |
| POST | `/api/slang/config` | src/console/routes/slang.js:258 |
| POST | `/api/slang/batch-confirm` | src/console/routes/slang.js:298 |
| POST | `/api/slang/batch-reject` | src/console/routes/slang.js:324 |

## handleAdminConfigSecurity（14 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/socialV2/reset` | src/console/routes/admin.js:180 |
| POST | `/api/socialV2/activity` | src/console/routes/admin.js:216 |
| GET | `/api/socialV2/activity` | src/console/routes/admin.js:238 |
| POST | `/api/socialV2/config` | src/console/routes/admin.js:246 |
| GET | `/api/socialV2/config` | src/console/routes/admin.js:285 |
| POST | `/api/console/notify-ai` | src/console/routes/admin.js:293 |
| POST | `/api/test-send` | src/console/routes/admin.js:366 |
| POST | `/api/security` | src/console/routes/admin.js:395 |
| GET | `/api/security` | src/console/routes/admin.js:413 |
| POST | `/api/whitelist` | src/console/routes/admin.js:421 |
| GET | `/api/whitelist` | src/console/routes/admin.js:460 |
| GET | `/api/pending` | src/console/routes/admin.js:468 |
| GET | `/api/sessions` | src/console/routes/admin.js:486 |
| POST | `/api/console/token` | src/console/routes/admin.js:499 |

## handleSocialV2ReadWrite（7 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/socialV2/context-shadow` | src/console/routes/socialV2.js:78 |
| GET | `/api/socialV2/state` | src/console/routes/socialV2.js:87 |
| GET | `/api/socialV2/prompt` | src/console/routes/socialV2.js:109 |
| GET | `/api/socialV2/unread` | src/console/routes/socialV2.js:201 |
| GET | `/api/socialV2/recent` | src/console/routes/socialV2.js:223 |
| POST | `/api/socialV2/mark-read` | src/console/routes/socialV2.js:241 |
| POST | `/api/socialV2/wake-config` | src/console/routes/socialV2.js:297 |

## handleAdminStateInspect（2 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/socialV2/states` | src/console/routes/admin.js:561 |
| POST | `/api/socialV2/wake` | src/console/routes/admin.js:581 |

## handleSendCore（3 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/socialV2/send-poke` | src/console/routes/send.js:66 |
| POST | `/api/socialV2/send-message` | src/console/routes/send.js:148 |
| POST | `/api/socialV2/send-burst` | src/console/routes/send.js:271 |

## handleStickerImageRoutes（7 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST（排除式） | `/api/socialV2/save-image` | src/console/routes/sticker.js:62 |
| GET | `/api/socialV2/image-list` | src/console/routes/sticker.js:86 |
| GET | `/api/socialV2/image-file` | src/console/routes/sticker.js:105 |
| GET | `/api/socialV2/sticker-image` | src/console/routes/sticker.js:124 |
| GET | `/api/socialV2/self-image` | src/console/routes/sticker.js:163 |
| POST | `/api/socialV2/sticker-note` | src/console/routes/sticker.js:184 |
| POST | `/api/socialV2/sticker-remark` | src/console/routes/sticker.js:206 |

## handleSendRich（4 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/socialV2/reload-memory` | src/console/routes/send.js:428 |
| POST | `/api/socialV2/send-voice` | src/console/routes/send.js:446 |
| POST | `/api/socialV2/send-image` | src/console/routes/send.js:517 |
| POST | `/api/socialV2/send-sticker` | src/console/routes/send.js:605 |

## handleStickerCollectRoutes（6 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/socialV2/collect-sticker` | src/console/routes/sticker.js:267 |
| GET | `/api/socialV2/sticker-list` | src/console/routes/sticker.js:312 |
| GET | `/api/stickers` | src/console/routes/sticker.js:343 |
| POST | `/api/stickers/sync` | src/console/routes/sticker.js:361 |
| POST | `/api/stickers/note` | src/console/routes/sticker.js:374 |
| POST | `/api/stickers/remark` | src/console/routes/sticker.js:390 |

## handleSendCheckWait（2 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/socialV2/check-send` | src/console/routes/send.js:726 |
| POST | `/api/socialV2/wait` | src/console/routes/send.js:760 |

## handleSocialV2LogsFeedback（6 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/socialV2/tool-log` | src/console/routes/socialV2.js:493 |
| POST | `/api/socialV2/tool-log/clear` | src/console/routes/socialV2.js:502 |
| GET | `/api/socialV2/feedback` | src/console/routes/socialV2.js:514 |
| POST | `/api/socialV2/feedback-clear` | src/console/routes/socialV2.js:522 |
| POST | `/api/socialV2/feedback` | src/console/routes/socialV2.js:533 |
| GET | `/api/socialV2/my-recent` | src/console/routes/socialV2.js:568 |

## handleSendRecordSentInternal（1 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/socialV2/record-sent` | src/console/routes/send.js:898 |

## handleSocialV2MessageDetail（1 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/socialV2/message-detail` | src/console/routes/socialV2.js:604 |

## handleForwardMedia（2 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/socialV2/forward-message` | src/console/routes/media.js:40 |
| POST | `/api/socialV2/forward-media` | src/console/routes/media.js:132 |

## handleSocialV2ActiveMembers（1 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/socialV2/active-members` | src/console/routes/socialV2.js:675 |

## handlePeopleMemoryRoutes（6 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/socialV2/people` | src/console/routes/memory.js:137 |
| POST | `/api/socialV2/memory-append` | src/console/routes/memory.js:163 |
| POST | `/api/socialV2/memory-update` | src/console/routes/memory.js:267 |
| GET | `/api/socialV2/memory` | src/console/routes/memory.js:355 |
| POST | `/api/socialV2/memory-remove` | src/console/routes/memory.js:497 |
| POST | `/api/socialV2/memory-clear` | src/console/routes/memory.js:531 |

## handleQzone1（8 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST（排除式） | `/api/socialV2/mood-comment` | src/console/routes/qzone.js:52 |
| GET（排除式） | `/api/socialV2/mood-new-comments` | src/console/routes/qzone.js:80 |
| POST（排除式） | `/api/socialV2/post-mood` | src/console/routes/qzone.js:97 |
| POST（排除式） | `/api/socialV2/delete-mood` | src/console/routes/qzone.js:133 |
| GET（排除式） | `/api/socialV2/mood-list` | src/console/routes/qzone.js:152 |
| GET（排除式） | `/api/socialV2/mood-comments` | src/console/routes/qzone.js:170 |
| GET（排除式） | `/api/socialV2/qzone-feeds` | src/console/routes/qzone.js:189 |
| GET（排除式） | `/api/socialV2/mood-status` | src/console/routes/qzone.js:208 |

## handleBilibili（5 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/bilibili` | src/console/routes/bilibili.js:38 |
| POST | `/api/bilibili/config` | src/console/routes/bilibili.js:39 |
| POST | `/api/bilibili/targets` | src/console/routes/bilibili.js:40 |
| POST | `/api/bilibili/targets/remove` | src/console/routes/bilibili.js:41 |
| POST | `/api/bilibili/check` | src/console/routes/bilibili.js:42 |

## handleBiliLook（2 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/bili-look/status` | src/console/routes/bili-look.js:10 |
| POST（排除式） | `/api/socialV2/bili-look` | src/console/routes/bili-look.js:31 |

## handleBiliScroll（1 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST（排除式） | `/api/socialV2/bili-scroll` | src/console/routes/bili-scroll.js:7 |

## handleSlangAiAndExpressionRoutes（4 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/expressions` | src/console/routes/slang.js:388 |
| POST | `/api/expressions/extract` | src/console/routes/slang.js:395 |
| POST | `/api/socialV2/slang/submit` | src/console/routes/slang.js:430 |
| GET | `/api/socialV2/slang/query` | src/console/routes/slang.js:491 |

## handleAuthorizeRead（1 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/authorize/read` | src/console/routes/admin.js:631 |

## handleImageMessageAndLegacySend（6 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| GET | `/api/images/message` | src/console/routes/media.js:197 |
| POST | `/api/send/group` | src/console/routes/media.js:248 |
| POST | `/api/send/private` | src/console/routes/media.js:248 |
| POST | `/api/send/reply` | src/console/routes/media.js:248 |
| GET | `/api/send/private` | src/console/routes/media.js:251 |
| GET | `/api/send/reply` | src/console/routes/media.js:252 |

## handleAdminDestructive（3 条）

| 方法 | 路径 | 文件:行 |
|---|---|---|
| POST | `/api/session/reset` | src/console/routes/admin.js:711 |
| POST | `/api/workspace/reset` | src/console/routes/admin.js:765 |
| POST | `/api/restart` | src/console/routes/admin.js:823 |

总计：25 个 handler、109 条路由。