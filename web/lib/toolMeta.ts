import {
  AppWindow, BookOpen, Brain, Camera, Clock, FileText, FilePlus, FolderSearch, GitBranch, Globe,
  Image, ListChecks, MousePointerClick, PencilLine, Share2, SquareTerminal, TextSearch, Users,
  Workflow, Wrench, type LucideIcon,
} from 'lucide-react';

/** An icon per tool, for the activity feed.
 *
 *  The icon is the whole signal: the feed draws tools in one muted colour, so what separates a read
 *  from a shell command is the mark, not a tint. Tools that do the same KIND of thing therefore share
 *  an icon (Grep and Search are both a text search) while tools that differ get their own.
 *
 *  Kept as a lookup rather than a convention over names because names are not systematic: `Bash` and
 *  `KillProcess` are both the shell, `Search` and `Glob` are both reads, and MCP tools arrive under a
 *  namespace that says nothing about what they do. An unknown tool gets a neutral wrench instead of a
 *  guess — this is decoration, and a confidently wrong icon is worse than an honest generic one. */

const EXACT: Record<string, LucideIcon> = {
  // Reading the project
  Read: FileText, FileInfo: FileText, LspHover: FileText, LspDocumentSymbol: FileText,
  Grep: TextSearch, Search: TextSearch, CodebaseSearch: TextSearch, LspWorkspaceSymbol: TextSearch,
  Glob: FolderSearch, ListDir: FolderSearch,
  DocsSearch: BookOpen, SkillLoad: BookOpen,
  GitStatus: GitBranch,

  // Changing the project
  Edit: PencilLine, Write: FilePlus,
  GenerateImage: Image, EditImage: Image,
  ShareFile: Share2, ShareImage: Share2,

  // The shell
  Bash: SquareTerminal, ProcessOutput: SquareTerminal,
  ListProcesses: SquareTerminal, KillProcess: SquareTerminal,

  // The outside world
  WebFetch: Globe, WebSearch: Globe,

  // Delegation
  Delegate: Users, DelegateContinue: Users, DelegateResult: Users, DelegateStatus: Users,
  DelegateList: Users, DelegateStop: Users, DelegateRead: Users,
  WorkflowStart: Workflow, WorkflowStatus: Workflow, WorkflowResume: Workflow,
  WorkflowStop: Workflow, WorkflowAddNodes: Workflow,

  // Bookkeeping
  MemoryAdd: Brain, MemorySearch: Brain, MemoryUpdate: Brain, MemoryDelete: Brain,
  MemoryMerge: Brain, MemoryListRecent: Brain, MemoryRecategorize: Brain,
  TaskCreate: ListChecks, TaskUpdate: ListChecks, TaskList: ListChecks,
  TaskGet: ListChecks, TaskDelete: ListChecks,
  CronAdd: Clock, CronList: Clock, CronRemove: Clock, ScheduleWakeup: Clock,
};

/** Browser automation is one namespace but several distinct acts, and a run of identical window glyphs
 *  would waste exactly the distinction the icons exist to make. */
function browserIcon(suffix: string): LucideIcon {
  if (suffix.includes('screenshot') || suffix.includes('snapshot')) return Camera;
  if (suffix.includes('navigate') || suffix.includes('new_page')) return Globe;
  if (suffix.includes('click') || suffix.includes('hover') || suffix.includes('fill') || suffix.includes('type')) {
    return MousePointerClick;
  }
  return AppWindow;
}

export function toolIcon(name: string): LucideIcon {
  const exact = EXACT[name];
  if (exact) return exact;
  if (name.startsWith('mcp__')) {
    const suffix = name.slice(name.lastIndexOf('__') + 2);
    return name.includes('chrome_devtools') ? browserIcon(suffix) : AppWindow;
  }
  if (name.startsWith('Delegate') || name.startsWith('Workflow')) return Users;
  if (name.startsWith('Memory')) return Brain;
  if (name.startsWith('Task')) return ListChecks;
  if (name.startsWith('Lsp')) return FileText;
  if (name.startsWith('Discord') || name.startsWith('Teams') || name.startsWith('Telegram')) return Globe;
  return Wrench;
}

/** `mcp__chrome_devtools__take_screenshot` reads as `take_screenshot`. The namespace is noise once the
 *  icon says "browser"; the full name stays in the title attribute. */
export function shortToolName(name: string): string {
  const parts = name.split('__');
  return parts[parts.length - 1] || name;
}
