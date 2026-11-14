import type { CSSProperties, ReactNode } from 'react';

const assetUrls = import.meta.glob('../demo/assets/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

function assetUrl(originalRef?: string) {
  if (!originalRef) return undefined;
  const match = Object.entries(assetUrls).find(([path]) => path.endsWith(originalRef.split('/').at(-1) ?? ''));
  return match?.[1];
}

function renderElement(element: any, key: string, actions: Map<string, any>, onAction?: (action: any) => void): ReactNode {
  switch (element.type) {
    case 'text': {
      const style = element.style ?? {};
      const styles: CSSProperties = { textAlign: style.align === 'center' ? 'center' : style.align === 'end' ? 'right' : 'left', fontWeight: style.emphasis === 'strong' || element.role === 'heading' ? 700 : 400, opacity: style.emphasis === 'muted' || element.role === 'caption' ? 0.7 : 1, margin: style.spacing === 'none' ? 0 : style.spacing === 'large' ? '1rem 0' : style.spacing === 'small' ? '0.25rem 0' : '0.5rem 0', fontSize: style.size === 'large' || element.role === 'heading' ? '1.1rem' : style.size === 'small' || element.role === 'caption' ? '0.85rem' : undefined };
      return <div key={key} style={styles}>{element.text}</div>;
    }
    case 'image': {
      const asset = actions.get(`asset:${element.assetId}`);
      const src = assetUrl(asset?.originalRef);
      return src ? <img key={key} src={src} alt={asset.alt} style={{ maxWidth: '100%', objectFit: element.fit ?? 'contain' }} /> : <span key={key}>{asset?.alt ?? 'Image unavailable'}</span>;
    }
    case 'icon': return <span key={key} role="img" aria-label={element.role ?? element.name}>{element.name}</span>;
    case 'container': {
      const style: CSSProperties = { display: 'flex', flexDirection: element.layout === 'row' ? 'row' : 'column', gap: '0.5rem', ...(element.layout === 'grid' ? { display: 'grid', gridTemplateColumns: `repeat(${element.columns ?? 2}, minmax(0, 1fr))` } : {}) };
      return <div key={key} style={style}>{element.children.map((child: any, index: number) => renderElement(child, `${key}-${index}`, actions, onAction))}</div>;
    }
    case 'list': return <ul key={key}>{element.items.map((item: any) => <li key={item.id}>{item.title}{item.description ? <small> — {item.description}</small> : null}{item.actionId && actions.has(item.actionId) ? <button onClick={() => onAction?.(actions.get(item.actionId))}>{actions.get(item.actionId).label ?? 'Open'}</button> : null}</li>)}</ul>;
    case 'divider': return <hr key={key} />;
    case 'action': {
      const action = actions.get(element.actionId);
      return action ? <button key={key} onClick={() => onAction?.(action)}>{element.label}</button> : null;
    }
    default: return null;
  }
}

export function DisplayDocumentView({ document, onAction }: { document: any; onAction?: (action: any) => void }) {
  const actions = new Map<string, any>((document.actions ?? []).map((action: any) => [action.id, action]));
  for (const asset of document.assets ?? []) actions.set(`asset:${asset.id}`, asset);
  return <article aria-label={document.title}>
    <h2>{document.title}</h2>
    <small>{document.source?.name} · {document.state}</small>
    {document.message ? <p>{document.message}</p> : null}
    {(document.pages ?? []).map((page: any) => <section key={page.id} aria-label={page.title ?? page.id}>
      {page.title ? <h3>{page.title}</h3> : null}
      {page.elements.map((element: any, index: number) => renderElement(element, `${page.id}-${index}`, actions, onAction))}
    </section>)}
  </article>;
}
