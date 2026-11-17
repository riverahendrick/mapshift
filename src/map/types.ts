export type SymKind = 'class' | 'interface' | 'function' | 'method' | 'type' | 'enum' | 'variable' | 'module'

/** Something defined in the code: a class, a function, a method, a type... */
export type Sym = {
  name: string
  /** The name with its containers, e.g. `Cart.total`. */
  qualified: string
  kind: SymKind
  /** First and last line, counting from 1. */
  start: number
  end: number
  /** The declaration line(s) without the body, whitespace collapsed. */
  signature: string
  exported: boolean
}

/** A use of a name: a call, or a `new`. */
export type Ref = {
  name: string
  /** What the name was called on (`this.repo` in `this.repo.save()`), or null for a plain call. */
  receiver: string | null
  line: number
  /** The qualified name of the definition the use sits in, or null at the top of the file. */
  from: string | null
  kind: 'call' | 'new'
}

/** One name brought in by an import. `imported` is `default`, `*` (the whole module) or the exported name. */
export type Imp = { source: string; local: string; imported: string }

export type Facts = { syms: Sym[]; refs: Ref[]; imps: Imp[] }
