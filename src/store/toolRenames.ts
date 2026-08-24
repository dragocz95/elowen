/**
 * The snake_case → TitleCase tool rename.
 *
 * Tool names are not just source literals: they are durable keys in user data — a user's tool allow-list
 * (`users.allowed_tools`) and deny-list (`users.disabled_tools`), their saved permission rules
 * (`user_settings['permissions']`), and every delegated child's frozen execution boundary
 * (`brain_sessions.delegated_access`). Every one of those match paths is an exact string compare, so a
 * stale name does not raise: it stops matching. A stale DENY silently RE-ENABLES its tool and the
 * `write_file`/`edit_file` "ask" defaults stop prompting (fail open); a stale ALLOW silently REMOVES a
 * tool the account was granted (fail closed). This map is the migration's whole contract (see db.ts).
 *
 * Exact names only, by design. Anything absent passes through untouched, which is exactly right for the
 * three kinds of stored name we must not touch: bridged `mcp__*` names (minted at runtime from a remote
 * server, out of scope), names from third-party or since-removed plugins, and the `*` wildcard.
 *
 * KNOWN GAP: a permission rule keyed on a PARTIAL glob (`discord_*`, `*_file`) also passes through, and
 * then matches nothing — a deny written that way goes dead, which fails open. Not migrated because a
 * partial glob cannot be mapped in general: `read_*` covered `read_file` and `read_process_output`, which
 * are now `Read` and `ProcessOutput` and share no prefix, so a prefix map would fix some families and
 * quietly miss the rest. Reachable only by writing the blob through the API — the account UI adds
 * free-text patterns to the `bash` scope only, and tools rules otherwise arrive from "Always allow" as
 * exact names. No such rule exists in any known deployment.
 */
const TOOL_RENAMES: Readonly<Record<string, string>> = {
  // files
  'read_file':    'Read',
  'write_file':   'Write',
  'edit_file':    'Edit',
  'list_dir':     'ListDir',
  'search_files': 'Search',
  'file_info':    'FileInfo',
  'git_status':   'GitStatus',
  // terminal
  'run_command':         'Bash',
  'list_processes':      'ListProcesses',
  'read_process_output': 'ProcessOutput',
  'kill_process':        'KillProcess',
  // subagent
  'delegate':           'Delegate',
  'delegate_models':    'DelegateModels',
  'delegate_status':    'DelegateStatus',
  'delegate_result':    'DelegateResult',
  'workflow_start':     'WorkflowStart',
  'workflow_add_nodes': 'WorkflowAddNodes',
  'workflow_status':    'WorkflowStatus',
  // cronjob
  'cron_add':        'CronAdd',
  'cron_list':       'CronList',
  'cron_remove':     'CronRemove',
  'schedule_wakeup': 'ScheduleWakeup',
  // codebase
  'codebase_search':  'CodebaseSearch',
  'codebase_reindex': 'CodebaseReindex',
  'codebase_status':  'CodebaseStatus',
  // skills
  'create_skill': 'CreateSkill',
  'list_skills':  'ListSkills',
  'delete_skill': 'DeleteSkill',
  // askuser + security-scan
  'ask_user_question': 'AskUserQuestion',
  'scan_code':         'ScanCode',
  // brain built-ins: control plane
  'elowen_list_tasks':    'ElowenListTasks',
  'elowen_create_task':   'ElowenCreateTask',
  'elowen_update_task':   'ElowenUpdateTask',
  'elowen_plan':          'ElowenPlan',
  'elowen_list_missions': 'ElowenListMissions',
  'elowen_list_sessions': 'ElowenListSessions',
  'elowen_close_task':    'ElowenCloseTask',
  // brain built-ins: lsp
  'lsp_diagnostics': 'LspDiagnostics',
  // brain built-ins: memory
  'memory_search':          'MemorySearch',
  'memory_add':             'MemoryAdd',
  'memory_update':          'MemoryUpdate',
  'memory_merge':           'MemoryMerge',
  'memory_delete':          'MemoryDelete',
  'memory_list_recent':     'MemoryListRecent',
  'memory_categories':      'MemoryCategories',
  'memory_category_create': 'MemoryCategoryCreate',
  'memory_category_delete': 'MemoryCategoryDelete',
  'memory_recategorize':    'MemoryRecategorize',
  // discord
  'discord_add_thread_member':    'DiscordAddThreadMember',
  'discord_api':                  'DiscordApi',
  'discord_archive_thread':       'DiscordArchiveThread',
  'discord_assign_role':          'DiscordAssignRole',
  'discord_channel_info':         'DiscordChannelInfo',
  'discord_create_category':      'DiscordCreateCategory',
  'discord_create_channel':       'DiscordCreateChannel',
  'discord_create_thread':        'DiscordCreateThread',
  'discord_delete_channel':       'DiscordDeleteChannel',
  'discord_delete_message':       'DiscordDeleteMessage',
  'discord_list_channels':        'DiscordListChannels',
  'discord_list_members':         'DiscordListMembers',
  'discord_list_pins':            'DiscordListPins',
  'discord_list_roles':           'DiscordListRoles',
  'discord_lock_thread':          'DiscordLockThread',
  'discord_member_info':          'DiscordMemberInfo',
  'discord_pin_message':          'DiscordPinMessage',
  'discord_purge_messages':       'DiscordPurgeMessages',
  'discord_read_channel':         'DiscordReadChannel',
  'discord_remove_role':          'DiscordRemoveRole',
  'discord_remove_thread_member': 'DiscordRemoveThreadMember',
  'discord_rename_channel':       'DiscordRenameChannel',
  'discord_search_members':       'DiscordSearchMembers',
  'discord_server_info':          'DiscordServerInfo',
  'discord_unpin_message':        'DiscordUnpinMessage',
  // telegram
  'telegram_api':                  'TelegramApi',
  'telegram_ban_member':           'TelegramBanMember',
  'telegram_chat_info':            'TelegramChatInfo',
  'telegram_close_forum_topic':    'TelegramCloseForumTopic',
  'telegram_create_forum_topic':   'TelegramCreateForumTopic',
  'telegram_delete_message':       'TelegramDeleteMessage',
  'telegram_edit_forum_topic':     'TelegramEditForumTopic',
  'telegram_get_members_count':    'TelegramGetMembersCount',
  'telegram_member_info':          'TelegramMemberInfo',
  'telegram_pin_message':          'TelegramPinMessage',
  'telegram_promote_member':       'TelegramPromoteMember',
  'telegram_send':                 'TelegramSend',
  'telegram_set_chat_description': 'TelegramSetChatDescription',
  'telegram_set_chat_title':       'TelegramSetChatTitle',
  'telegram_unban_member':         'TelegramUnbanMember',
  'telegram_unpin_message':        'TelegramUnpinMessage',
  // whatsapp
  'whatsapp_group_add':    'WhatsappGroupAdd',
  'whatsapp_group_create': 'WhatsappGroupCreate',
  'whatsapp_group_info':   'WhatsappGroupInfo',
  'whatsapp_group_list':   'WhatsappGroupList',
  'whatsapp_group_remove': 'WhatsappGroupRemove',
  'whatsapp_send':         'WhatsappSend',
};

/** Remap one stored tool name. Not-renamed → unchanged (see TOOL_RENAMES on why that is the right default). */
export const renameTool = (name: string): string => TOOL_RENAMES[name] ?? name;

/**
 * The same rename for the tools that ship from the marketplace registry (todo, web, mem0, image-gen,
 * image-edit) rather than in the box.
 *
 * A map of its own, deliberately. TOOL_RENAMES above is the v1 migration's frozen contract over what was
 * installed WITH the daemon; these plugins carry their own versions and renamed on their own release, after
 * v1 had already run and marked itself done. So they get their own migration (db.ts v3) over their own map,
 * and each migration keeps encoding the history it actually shipped.
 *
 * The stakes are the built-ins' stakes: these names are exact-match keys in a user's deny-list and saved
 * rules, and a stale DENY does not raise — it stops matching, and the tool it was switched off comes back on.
 *
 * `search_memory` deliberately does NOT become `MemorySearch`. That name is already the brain's own memory
 * tool, and mem0 REPLACES that backend rather than extending it — two tools answering to one name is how a
 * call reaches the wrong store. Namespaced to its plugin instead.
 */
const REGISTRY_TOOL_RENAMES: Readonly<Record<string, string>> = {
  // todo
  'todo_write':     'TodoWrite',
  'todo_read':      'TodoRead',
  // web
  'web_search':     'WebSearch',
  'web_fetch':      'WebFetch',
  // mem0 — namespaced, not Memory*, see above
  'add_memory':     'Mem0Add',
  'search_memory':  'Mem0Search',
  // image-gen / image-edit. Verb-first, because each is a plugin with ONE tool rather than a service with
  // a family of them — the same shape as `create_skill` → CreateSkill and `scan_code` → ScanCode. A family
  // is what earns a prefix (CronAdd, MemorySearch, and Mem0Search just above).
  'generate_image': 'GenerateImage',
  'edit_image':     'EditImage',
};

/** Remap one stored registry-plugin tool name. Not-renamed → unchanged. */
export const renameRegistryTool = (name: string): string => REGISTRY_TOOL_RENAMES[name] ?? name;

/**
 * Repair for the two image tools, which 0.27.5 renamed prefix-first before the plugins themselves shipped
 * verb-first. `generate_image` became `ImageGenerate` for the short while 0.27.5 was the published release;
 * the map above now says `GenerateImage`, but v3 had already marked itself done for anyone who ran it, and
 * a corrected map is not retroactive. The tools never answered to the prefix-first names — no plugin ever
 * registered them — so a rule left on one matches nothing at all, and a DENY that matches nothing is a
 * tool switched back on.
 *
 * Only these two. The rest of v3's map (todo, web, mem0) was right the first time and is not re-applied.
 */
const IMAGE_TOOL_REPAIR: Readonly<Record<string, string>> = {
  'ImageGenerate': 'GenerateImage',
  'ImageEdit':     'EditImage',
};

/** Remap one stored image tool name off the short-lived 0.27.5 spelling. Anything else → unchanged. */
export const repairImageTool = (name: string): string => IMAGE_TOOL_REPAIR[name] ?? name;

/**
 * The docs tool lost its brand: the manual it searches ships with every deployment, but the product name
 * is configurable, so `ElowenDocs` became `DocsSearch` (mirroring `CodebaseSearch`, the tool it most needs
 * to be told apart from).
 *
 * Renaming a tool is never only a source change. The stored name is an exact-match key in a user's
 * deny-list, their saved permission rules, a platform role's allow-list, and — the one that actually bit
 * here — `brain_sessions.delegated_access`, the frozen execution boundary every delegated sub-agent
 * inherits. Those boundaries are allow-lists: 754 of them name the old tool, so without this migration a
 * read-only sub-agent that was granted the manual silently loses it. The deny direction is worse in kind
 * (a stale deny switches its tool back ON), which is why this runs even though this instance happens to
 * have no deny rule naming it.
 */
const DOCS_TOOL_RENAMES: Readonly<Record<string, string>> = {
  'ElowenDocs': 'DocsSearch',
};

/** Remap the stored docs tool name onto its unbranded spelling. Anything else → unchanged. */
export const renameDocsTool = (name: string): string => DOCS_TOOL_RENAMES[name] ?? name;
