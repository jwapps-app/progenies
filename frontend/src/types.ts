export interface UserInfo {
  id: string;
  username: string;
  is_admin: boolean;
  created_at: string;
}

export interface Tree {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  /** This user's access to the tree: "owner" | "editor" | "viewer". */
  role: string;
  /** For trees shared with this user, the owner's username; null when owned. */
  owner_username: string | null;
}

/** A collaborator grant on a tree. */
export interface Share {
  user_id: string;
  username: string;
  /** "viewer" (read-only) | "editor" (read + write) */
  role: string;
}

/** A pickable account for the sharing dialog (id + username only). */
export interface DirectoryUser {
  id: string;
  username: string;
}

export interface Individual {
  id: string;
  tree_id: string;
  given_name: string | null;
  middle_name: string | null;
  surname: string | null;
  married_name: string | null;
  /** Familiar name, shown in quotes (e.g. Robert "Bob" Smith). */
  nickname: string | null;
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
  married_name?: string | null;
  nickname?: string | null;
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

type NamedPerson = {
  given_name: string | null;
  middle_name?: string | null;
  surname: string | null;
  married_name?: string | null;
  nickname?: string | null;
};

/** The surname to display: the married name when set, otherwise the birth surname. */
export function displaySurname(person: NamedPerson): string | null {
  return person.married_name || person.surname || null;
}

export function displayName(person: NamedPerson | null | undefined): string {
  if (!person) return "Unknown";
  const nick = person.nickname?.trim();
  const name = [
    person.given_name,
    nick ? `"${nick}"` : null,
    person.middle_name,
    displaySurname(person),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "Unknown";
}

/** Full name with the birth/maiden surname shown as "née …" when a married name
 * is set — e.g. "Mary Jones née Smith". */
export function fullNameWithMaiden(person: NamedPerson | null | undefined): string {
  if (!person) return "Unknown";
  const base = displayName(person);
  if (person.married_name && person.surname && person.married_name !== person.surname) {
    return `${base} née ${person.surname}`;
  }
  return base;
}
