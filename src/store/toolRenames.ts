/**
 * The snake_case → TitleCase tool rename.
 *
 * Tool names are not just source literals: they are durable keys in user data — a user's tool deny-list
 * (`users.disabled_tools`), their saved permission rules (`user_settings['permissions']`), every
 * delegated child's frozen execution boundary (`brain_sessions.delegated_access`), and a platform role's
 * tool allow-list (`settings.data` → `plugins.config.*.rolePolicies[].tools`). Every one of those match
 * paths is an exact string compare, so a stale name does not raise: it stops matching. A stale DENY
 * silently RE-ENABLES its tool and the `write_file`/`edit_file` "ask" defaults stop prompting (fail
 * open); a stale ALLOW-list leaves a role with no tools at all (fail closed). This map is the migration's
 * whole contract (see db.ts).
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
