# Feature studies

This directory holds dated research notes rather than reference documentation. Each study compares one domain of an external coding agent against Elowen's implementation at the time of writing, and ends every finding with an explicit verdict: adopt, adapt, skip, or already implemented. They exist to record why a design decision was taken, including the decisions that were deliberately not taken.

Read them as history. The comparison snapshot is Elowen release `0.28.24`, and several of the recommendations have shipped since, among them the fork-based sub-agent context handover, cold tool-result clearing at the start of a turn, in-session compaction on the warm prefix, the file tools' alignment with the reference behaviour, and the two-minute default shell timeout. For the current behaviour of any of these, use the reference documents listed in [`../index.md`](../index.md) and the code, not these notes.

| Study | Domain |
| --- | --- |
| [Agent loop and orchestration](claude-code-agent-loop.md) | The main turn loop, streaming and tool-call interplay, mid-turn steering, sub-agent orchestration, model routing, retry and fallback, and autonomy mechanisms. |
| [Context and token management](claude-code-context-management.md) | Context and token budgeting, compaction, tool-result aging, cache-prefix stability, and how context usage is reported to the user. |
| [Session state and configuration](claude-code-session-state.md) | Session persistence, configuration layering, account and project settings, and the project/repository layer. |
| [Tool system and safety layer](claude-code-tool-system.md) | Tool definition and prompting, permission decisions, intervention hooks, file and shell guards, MCP namespacing, result shaping, and what is advertised to the model at any moment. |

Adding a study here is appropriate when an investigation produces a durable design conclusion that the reference documents should not carry, because they describe what the system does rather than which alternatives were weighed. State the snapshot the study was written against in its opening lines so a later reader can tell how much of it still holds.
