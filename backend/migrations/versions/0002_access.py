"""Document ownership and per-user access grants.

Existing documents get no owner and no grants: until an administrator shares them,
only administrators can open them.
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("documents") as batch:
        batch.add_column(sa.Column("owner_id", sa.String(), nullable=True))
        batch.create_foreign_key(
            "fk_documents_owner_id_users", "users", ["owner_id"], ["id"], ondelete="SET NULL"
        )
    op.create_table(
        "document_access",
        sa.Column(
            "document_id",
            sa.String(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("level", sa.String(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("document_access")
    with op.batch_alter_table("documents") as batch:
        batch.drop_constraint("fk_documents_owner_id_users", type_="foreignkey")
        batch.drop_column("owner_id")
