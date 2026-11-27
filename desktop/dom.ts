// IDs are declared in the desktop page and looked up after it loads.
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
