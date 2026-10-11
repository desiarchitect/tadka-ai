CREATE SCHEMA "assist";
--> statement-breakpoint
CREATE TABLE "assist"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assist"."memories" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_user_id_kind_pk" PRIMARY KEY("user_id","kind"),
	CONSTRAINT "memories_kind_ck" CHECK ("assist"."memories"."kind" = 'diet' and "assist"."memories"."value" = 'vegetarian')
);
--> statement-breakpoint
CREATE TABLE "assist"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_no" integer NOT NULL,
	"seq" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_seq_uq" UNIQUE("conversation_id","seq")
);
--> statement-breakpoint
CREATE TABLE "assist"."turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_no" integer NOT NULL,
	"user_text" text NOT NULL,
	"answer" text NOT NULL,
	"stop_reason" text NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_conversation_turn_uq" UNIQUE("conversation_id","turn_no")
);
--> statement-breakpoint
ALTER TABLE "restaurant"."menu_items" ADD COLUMN "is_veg" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assist"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "assist"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assist"."turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "assist"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_ix" ON "assist"."conversations" USING btree ("user_id","last_message_at");