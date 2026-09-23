/** Split PostgreSQL statements without interpreting strings, comments or dollar-quoted function bodies.
 * Only a single outer BEGIN/COMMIT pair is supported. Other transaction control fails closed.
 */
export function migrationStatements(source: string): string[] {
  const statements: string[] = [];
  let buffer = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("--", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
      buffer += "\n";
    } else if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unclosed SQL comment");
      buffer += " ";
    } else if (source[i] === "'" || source[i] === '"') {
      const quote = source[i]!;
      const escaped = quote === "'" && /(?:^|\W)[eE]$/.test(buffer);
      buffer += source[i++];
      let closed = false;
      while (i < source.length) {
        const ch = source[i++]!;
        buffer += ch;
        if (escaped && ch === "\\") { buffer += source[i++] ?? ""; continue; }
        if (ch === quote) {
          if (source[i] === quote) buffer += source[i++];
          else { closed = true; break; }
        }
      }
      if (!closed) throw new Error("Unclosed SQL string");
    } else if (source[i] === "$" && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(source.slice(i))) {
      const delimiter = source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)![0];
      const end = source.indexOf(delimiter, i + delimiter.length);
      if (end < 0) throw new Error("Unclosed SQL function body");
      buffer += source.slice(i, end + delimiter.length);
      i = end + delimiter.length;
    } else if (source[i] === ";") {
      if (buffer.trim()) statements.push(buffer.trim());
      buffer = ""; i++;
    } else buffer += source[i++];
  }
  if (buffer.trim()) statements.push(buffer.trim());
  if (/^BEGIN(?:\s+(?:WORK|TRANSACTION))?$/i.test(statements[0] ?? "")) {
    if (!/^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i.test(statements.at(-1) ?? "")) {
      throw new Error("Migration requires one matching outer BEGIN/COMMIT");
    }
    statements.shift(); statements.pop();
  }
  for (const statement of statements) {
    if (/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+(?:LOCAL\s+|SESSION\s+)?(?:TRANSACTION|CHARACTERISTICS)|SET\s+(?:LOCAL\s+|SESSION\s+)?standard_conforming_strings)\b/i.test(statement)) {
      throw new Error("Transaction control inside migration is not supported");
    }
  }
  return statements;
}
