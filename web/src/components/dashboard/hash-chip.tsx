/**
 * Displays long identifiers and hashes without making dense tables unreadable.
 *
 * @param props - Hash-like value and optional visible character count.
 * @returns Monospace truncated identifier preserving copyable full text in the title.
 */
export function HashChip(props: { value: string; visible?: number }) {
  const visible = props.visible ?? 10;
  const compact =
    props.value.length > visible * 2
      ? `${props.value.slice(0, visible)}...${props.value.slice(-visible)}`
      : props.value;

  return (
    <span className="rounded-md border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground" title={props.value}>
      {compact}
    </span>
  );
}
