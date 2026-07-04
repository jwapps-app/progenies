"""SQLAlchemy ORM models for the genealogy schema.

UUID primary keys are generated application-side (uuid4) so no PostgreSQL
extension (pgcrypto) is required. Column types and relationships mirror the
canonical SQL schema for round-trip GEDCOM fidelity.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    username: Mapped[str] = mapped_column(Text, unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    # The first registered account is the administrator: open registration closes
    # after it exists, and only admins can create/manage further accounts.
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    trees: Mapped[list["FamilyTree"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class FamilyTree(Base):
    __tablename__ = "family_trees"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship(back_populates="trees")
    individuals: Mapped[list["Individual"]] = relationship(
        back_populates="tree", cascade="all, delete-orphan"
    )
    families: Mapped[list["Family"]] = relationship(
        back_populates="tree", cascade="all, delete-orphan"
    )
    sources: Mapped[list["Source"]] = relationship(
        back_populates="tree", cascade="all, delete-orphan"
    )
    shares: Mapped[list["TreeShare"]] = relationship(
        back_populates="tree", cascade="all, delete-orphan"
    )


class TreeShare(Base):
    """A collaborator grant: another user's access to a tree they don't own.

    The tree's `user_id` is always the owner (full control, including sharing);
    a share row grants a second user either read-only ('viewer') or edit
    ('editor') access. Both foreign keys cascade, so deleting the tree or the
    collaborator removes the grant automatically.
    """

    __tablename__ = "tree_shares"

    tree_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("family_trees.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[str] = mapped_column(Text, nullable=False, default="editor")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    tree: Mapped["FamilyTree"] = relationship(back_populates="shares")
    user: Mapped["User"] = relationship()

    __table_args__ = (
        CheckConstraint("role IN ('viewer', 'editor')", name="ck_tree_share_role"),
    )


class Individual(Base):
    __tablename__ = "individuals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tree_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("family_trees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    given_name: Mapped[str | None] = mapped_column(Text)
    middle_name: Mapped[str | None] = mapped_column(Text)
    # Birth / maiden surname (the genealogical anchor).
    surname: Mapped[str | None] = mapped_column(Text)
    # Surname acquired through marriage, when different from the birth surname.
    # Shown as the display surname while `surname` is preserved as "née …".
    married_name: Mapped[str | None] = mapped_column(Text)
    # Familiar name, shown in quotes (e.g. Robert "Bob" Smith).
    nickname: Mapped[str | None] = mapped_column(Text)
    sex: Mapped[str | None] = mapped_column(String(1))  # M, F, U (unknown)
    birth_date: Mapped[str | None] = mapped_column(Text)
    birth_place: Mapped[str | None] = mapped_column(Text)
    death_date: Mapped[str | None] = mapped_column(Text)
    death_place: Mapped[str | None] = mapped_column(Text)
    # Free-text age / lifespan for when exact birth & death dates are unknown
    # (e.g. "930" for biblical lifespans, or "~72"). Display-only; not exported
    # to GEDCOM 5.5 (no standard tag).
    age: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    # Small profile thumbnail stored as a data: URL (resized client-side). Not
    # exported to GEDCOM 5.5; a display convenience for personal trees.
    photo_url: Mapped[str | None] = mapped_column(Text)
    gedcom_xref: Mapped[str | None] = mapped_column(Text, index=True)
    is_unknown: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    tree: Mapped["FamilyTree"] = relationship(back_populates="individuals")
    citations: Mapped[list["Citation"]] = relationship(
        back_populates="individual", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("sex IN ('M', 'F', 'U') OR sex IS NULL", name="ck_individual_sex"),
    )


class Family(Base):
    __tablename__ = "families"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tree_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("family_trees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    husband_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("individuals.id", ondelete="SET NULL"), index=True
    )
    wife_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("individuals.id", ondelete="SET NULL"), index=True
    )
    married_date: Mapped[str | None] = mapped_column(Text)
    married_place: Mapped[str | None] = mapped_column(Text)
    divorced_date: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    # Order of this marriage for the bloodline person (1 = first spouse, etc.).
    # Drives "1st / 2nd / 3rd wife" labels and left-to-right ordering in charts.
    marriage_order: Mapped[int | None] = mapped_column(Integer)
    # TRUE for an "unknown-depth descendant" link: the child is known to descend
    # from the parent but the intermediate generations are unknown. Rendered with
    # a dotted connector.
    gap: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # TRUE for known co-parents who are NOT married (a child link without a
    # marriage). Rendered as a dotted connector with no marriage symbol.
    unmarried: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    gedcom_xref: Mapped[str | None] = mapped_column(Text, index=True)

    tree: Mapped["FamilyTree"] = relationship(back_populates="families")
    husband: Mapped["Individual"] = relationship(foreign_keys=[husband_id])
    wife: Mapped["Individual"] = relationship(foreign_keys=[wife_id])
    children: Mapped[list["Child"]] = relationship(
        back_populates="family", cascade="all, delete-orphan"
    )


class Child(Base):
    __tablename__ = "children"

    family_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("families.id", ondelete="CASCADE"), primary_key=True
    )
    individual_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("individuals.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    birth_order: Mapped[int | None] = mapped_column(Integer)
    # How the child relates to this family: biological | adopted | step | foster.
    relation: Mapped[str] = mapped_column(Text, default="biological", nullable=False)

    family: Mapped["Family"] = relationship(back_populates="children")
    individual: Mapped["Individual"] = relationship()


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tree_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("family_trees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    publisher: Mapped[str | None] = mapped_column(Text)
    date: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    gedcom_xref: Mapped[str | None] = mapped_column(Text, index=True)

    tree: Mapped["FamilyTree"] = relationship(back_populates="sources")
    citations: Mapped[list["Citation"]] = relationship(
        back_populates="source", cascade="all, delete-orphan"
    )


class Citation(Base):
    __tablename__ = "citations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    individual_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("individuals.id", ondelete="CASCADE"), nullable=False
    )
    page: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)

    source: Mapped["Source"] = relationship(back_populates="citations")
    individual: Mapped["Individual"] = relationship(back_populates="citations")


class GedcomFile(Base):
    __tablename__ = "gedcom_files"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tree_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("family_trees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    filename: Mapped[str | None] = mapped_column(Text)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str | None] = mapped_column(Text)
    file_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("direction IN ('import', 'export')", name="ck_gedcom_direction"),
    )


class DismissedWarning(Base):
    """A data-integrity warning the user has reviewed and dismissed. Keyed by a
    stable, content-derived string (see frontend findWarnings) so it re-surfaces
    if the underlying data later changes."""

    __tablename__ = "dismissed_warnings"

    tree_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("family_trees.id", ondelete="CASCADE"), primary_key=True
    )
    warning_key: Mapped[str] = mapped_column(Text, primary_key=True)


class DismissedDuplicate(Base):
    """A pair of individuals the user has confirmed are NOT duplicates, so the
    duplicate finder stops flagging them. `individual_a` < `individual_b` (sorted)
    so each pair is stored once regardless of order."""

    __tablename__ = "dismissed_duplicates"

    tree_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("family_trees.id", ondelete="CASCADE"), primary_key=True
    )
    individual_a: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("individuals.id", ondelete="CASCADE"), primary_key=True
    )
    individual_b: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("individuals.id", ondelete="CASCADE"), primary_key=True
    )
