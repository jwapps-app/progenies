"""Pydantic request/response schemas for the API."""
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _validate_password_bytes(value: str) -> str:
    """bcrypt silently ignores everything past the 72th BYTE (not character);
    a UTF-8 password can be under 72 chars yet over 72 bytes, which would
    truncate silently. Reject those explicitly so no password is weakened."""
    if len(value.encode("utf-8")) > 72:
        raise ValueError("password must be at most 72 bytes")
    return value


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=72)

    _check_password = field_validator("password")(_validate_password_bytes)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    is_admin: bool = False
    created_at: datetime


class RegistrationStatus(BaseModel):
    # TRUE only while no account exists yet: the first registration creates the
    # administrator, after which open registration is closed.
    open: bool


class PasswordReset(BaseModel):
    password: str = Field(min_length=8, max_length=72)

    _check_password = field_validator("password")(_validate_password_bytes)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    username: str
    is_admin: bool = False


# ---------------------------------------------------------------------------
# Trees
# ---------------------------------------------------------------------------
class TreeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None


class TreeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


class TreeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    # The requesting user's access to this tree, and (for shared trees) who owns
    # it. Owned trees report role="owner" with owner_username = the requester.
    role: str = "owner"
    owner_username: str | None = None
    # Public read-only link token — present only for the OWNER's view.
    share_token: str | None = None


# ---------------------------------------------------------------------------
# Collaboration / sharing
# ---------------------------------------------------------------------------
class ShareCreate(BaseModel):
    user_id: uuid.UUID
    role: str = Field(default="editor", pattern="^(viewer|editor)$")


class ShareOut(BaseModel):
    user_id: uuid.UUID
    username: str
    role: str


class UserDirectoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str


# ---------------------------------------------------------------------------
# Individuals
# ---------------------------------------------------------------------------
class IndividualBase(BaseModel):
    given_name: str | None = None
    middle_name: str | None = None
    surname: str | None = None
    married_name: str | None = None
    nickname: str | None = None
    sex: str | None = Field(default=None, pattern="^[MFU]$")
    birth_date: str | None = None
    birth_place: str | None = None
    death_date: str | None = None
    death_place: str | None = None
    age: str | None = None
    notes: str | None = None
    photo_url: str | None = None
    # Writable so client-side restore (undo of a delete) can preserve the
    # original GEDCOM id — round-trip fidelity survives a delete+undo.
    gedcom_xref: str | None = None


def _validate_photo_url(value: str | None) -> str | None:
    """Only accept inline image data URIs. The chart renders photo_url as an SVG
    <image href>, so an arbitrary URL would allow off-site references (tracking,
    SSRF-ish beacons) or a `javascript:`/`data:text/html` payload. Restricting
    to data:image/ keeps photos self-contained and inert."""
    if not value:
        return value
    if not value.startswith("data:image/"):
        raise ValueError("photo_url must be an inline data:image/ URL")
    return value


class IndividualCreate(IndividualBase):
    is_unknown: bool = False

    _check_photo = field_validator("photo_url")(_validate_photo_url)


class IndividualUpdate(IndividualBase):
    _check_photo = field_validator("photo_url")(_validate_photo_url)


class IndividualOut(IndividualBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tree_id: uuid.UUID
    is_unknown: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Families
# ---------------------------------------------------------------------------
class MergeRequest(BaseModel):
    duplicate_id: uuid.UUID  # the record to merge INTO the survivor (path id)


class DuplicatePairRequest(BaseModel):
    id_a: uuid.UUID
    id_b: uuid.UUID


class WarningKeyRequest(BaseModel):
    key: str = Field(min_length=1, max_length=512)


class DismissedPairOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    individual_a: uuid.UUID
    individual_b: uuid.UUID


class ChildRef(BaseModel):
    individual_id: uuid.UUID
    birth_order: int | None = None
    relation: str = Field(default="biological", pattern="^(biological|adopted|step|foster)$")


class FamilyBase(BaseModel):
    husband_id: uuid.UUID | None = None
    wife_id: uuid.UUID | None = None
    married_date: str | None = None
    married_place: str | None = None
    divorced_date: str | None = None
    notes: str | None = None
    marriage_order: int | None = None
    # "Unknown-depth descendant" link (rendered dotted).
    gap: bool = False
    # Known co-parents who are not married (dotted, no marriage symbol).
    unmarried: bool = False


class FamilyCreate(FamilyBase):
    children: list[ChildRef] = Field(default_factory=list)


class FamilyUpdate(FamilyBase):
    children: list[ChildRef] | None = None


class ChildOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    individual_id: uuid.UUID
    birth_order: int | None
    relation: str = "biological"


class FamilyOut(FamilyBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tree_id: uuid.UUID
    gedcom_xref: str | None
    children: list[ChildOut]


# ---------------------------------------------------------------------------
# Public share link — deliberately SLIM DTOs.
#
# The /public/{token} surface is unauthenticated, so it must expose only what
# the read-only chart renders and NOTHING more. In particular it must never
# leak free-text `notes`, birth/death `places`, `gedcom_xref`, timestamps, or
# `tree_id` — the full IndividualOut/FamilyOut carry all of those.
# ---------------------------------------------------------------------------
class PublicIndividualOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    given_name: str | None = None
    middle_name: str | None = None
    surname: str | None = None
    married_name: str | None = None
    nickname: str | None = None
    sex: str | None = None
    birth_date: str | None = None
    death_date: str | None = None
    age: str | None = None
    is_unknown: bool


class PublicFamilyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    husband_id: uuid.UUID | None = None
    wife_id: uuid.UUID | None = None
    marriage_order: int | None = None
    gap: bool = False
    unmarried: bool = False
    children: list[ChildOut]


# ---------------------------------------------------------------------------
# Sources & citations
# ---------------------------------------------------------------------------
class SourceBase(BaseModel):
    title: str | None = None
    author: str | None = None
    publisher: str | None = None
    date: str | None = None
    notes: str | None = None


class SourceCreate(SourceBase):
    pass


class SourceUpdate(SourceBase):
    pass


class SourceOut(SourceBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tree_id: uuid.UUID
    gedcom_xref: str | None = None


class CitationCreate(BaseModel):
    source_id: uuid.UUID
    page: str | None = None
    notes: str | None = None


class CitationOut(BaseModel):
    id: uuid.UUID
    source_id: uuid.UUID
    individual_id: uuid.UUID
    page: str | None = None
    notes: str | None = None
    # Denormalized for display without a second fetch.
    source_title: str | None = None


# ---------------------------------------------------------------------------
# GEDCOM
# ---------------------------------------------------------------------------
class ImportSummary(BaseModel):
    individuals_imported: int
    families_imported: int
    children_links: int
    sources_imported: int
    unknown_spouses_created: int
    warnings: list[str]


# ---------------------------------------------------------------------------
# Visualization (recursive descendant / ancestor trees)
# ---------------------------------------------------------------------------
class TreeNode(BaseModel):
    """Ancestor-chart node. `children` holds the next generation outward (parents)."""

    id: uuid.UUID
    given_name: str | None
    middle_name: str | None
    surname: str | None
    married_name: str | None = None
    nickname: str | None = None
    sex: str | None
    birth_date: str | None
    death_date: str | None
    age: str | None
    is_unknown: bool
    generation: int
    photo_url: str | None = None
    children: list["TreeNode"] = Field(default_factory=list)


class DescendantNode(BaseModel):
    """Descendant-chart node, modeled as a person plus their marriage `unions`.

    Each union carries the co-parent (`spouse`) and the `children` of that union.
    A spouse is itself a DescendantNode whose `unions` are that spouse's OTHER
    marriages — this is how converging family lines (e.g. a widow's remarriage)
    are surfaced. Recursion is de-duplicated server-side to avoid cycles.
    """

    id: uuid.UUID
    given_name: str | None
    middle_name: str | None
    surname: str | None
    married_name: str | None = None
    nickname: str | None = None
    sex: str | None
    birth_date: str | None
    death_date: str | None
    age: str | None
    is_unknown: bool
    generation: int
    photo_url: str | None = None
    # How this person relates to their parents in this chart (biological by
    # default; adopted/step/foster for non-biological child links).
    relation: str = "biological"
    unions: list["DescendantUnion"] = Field(default_factory=list)


class DescendantUnion(BaseModel):
    spouse: "DescendantNode | None" = None
    children: list["DescendantNode"] = Field(default_factory=list)
    # 1-based position of this marriage for the person (1st, 2nd, 3rd spouse).
    ordinal: int = 1
    # TRUE when this is an "unknown-depth descendant" link (rendered dotted).
    gap: bool = False
    # TRUE when the co-parents are not married (dotted, no marriage symbol).
    unmarried: bool = False
    # TRUE when the marriage ended in divorce (rendered with the divorce symbol ⚮).
    divorced: bool = False
