import { useState } from 'react';
export function Typed<T>(props: { v: Array<T>; ok: boolean }) {
  const [s] = useState<string>('a');
  const x = props.ok ? (s as string) : 'n';
  return <aside data-ada-src="kept">{x}</aside>;
}
