/** The plugin's one way to turn a caught unknown into text.
 *
 *  Every catch here feeds the same two sinks: a logger warning, or a stored `Error: …` result a parent
 *  model reads. Both want the message alone — `String(err)` on an Error would prefix a redundant
 *  "Error: " that then reads as "Error: Error: …" in a stored result. */
export const errorText = (e) => (e instanceof Error ? e.message : String(e));
