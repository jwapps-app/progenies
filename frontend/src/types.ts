export interface Tree {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Individual {
  id: string;
  tree_id: string;
  given_name: string | null;
  middle_name: string | null;
  surname: string | null;
  sex: string | null;
  birth_date: string | null;
  birth_place: string | null;
  death_date: string | null;
  death_place: string | null;
  age: string | null;
  notes: string | null;
  /** Small profile thumbnail as a data: URL, or null. */
  photo_url: string | null;
  gedcom_xref: string | null;
  is_unknown: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChildRef {
  individual_id: string;
  birth_order: number | null;
  /** biological | adopted | step | foster */
  relation: string;
}

export interface Family {
  id: string;
  tree_id: string;
  husband_id: string | null;
  wife_id: string | null;
  married_date: string | null;
  married_place: string | null;
  divorced_date: string | null;
  notes: string | null;
  marriage_order: number | null;
  /** True for an "unknown-depth descendant" link (rendered with a dotted line). */
  gap: boolean;
  /** True for known co-parents who are not married (dotted, no marriage symbol). */
  unmarried: boolean;
  gedcom_xref: string | null;
  children: ChildRef[];
}

export interface TreeUnion {
  spouse: TreeNode | null;
  children: TreeNode[];
  ordinal: number; // 1-based marriage position (1st, 2nd, 3rd spouse)
  gap: boolean; // unknown-depth descendant link → dotted connector
  unmarried: boolean; // known co-parents, not married → dotted, no marriage symbol
  divorced: boolean; // marriage ended in divorce → divorce symbol ⚮
}

export interface TreeNode {
  id: string;
  given_name: string | null;
  middle_name: string | null;
  surname: string | null;
  sex: string | null;
  birth_date: string | null;
  death_date: string | null;
  age: string | null;
  is_unknown: boolean;
  generation: number;
  photo_url?: string | null;
  /** How this person relates to their parents (biological | adopted | step | foster). */
  relation?: string;
  // Each union = a co-parent (spouse) + that union's children. A spouse may
  // itself carry unions (its OTHER marriages) for converging family lines.
  unions: TreeUnion[];
}

/** Ancestor-chart node: `children` holds the next generation OUTWARD (parents). */
export interface AncestorNode {
  id: string;
  given_name: string | null;
  middle_name: string | null;
  surname: string | null;
  sex: string | null;
  birth_date: string | null;
  death_date: string | null;
  age: string | null;
  is_unknown: boolean;
  generation: number;
  photo_url?: string | null;
  children: AncestorNode[];
}

export interface ImportSummary {
  individuals_imported: number;
  families_imported: number;
  children_links: number;
  sources_imported: number;
  unknown_spouses_created: number;
  warnings: string[];
}

export function displayName(
  person:
    | { given_name: string | null; middle_name?: string | null; surname: string | null }
    | null
    | undefined
): string {
  if (!person) return "Unknown";
  const name = [person.given_name, person.middle_name, person.surname]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "Unknown";
}
