CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE SCHEMA "ordering";
--> statement-breakpoint
CREATE SCHEMA "payment";
--> statement-breakpoint
CREATE SCHEMA "restaurant";
--> statement-breakpoint
CREATE TABLE "restaurant"."menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_paise" integer NOT NULL,
	CONSTRAINT "menu_items_price_ck" CHECK ("restaurant"."menu_items"."price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "ordering"."order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ordering"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"status" text NOT NULL,
	"total_paise" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"delivery_address" text NOT NULL,
	"contact_phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_status_ck" CHECK ("ordering"."orders"."status" in ('Placed', 'Confirmed', 'Preparing', 'OutForDelivery', 'Delivered', 'Cancelled'))
);
--> statement-breakpoint
CREATE TABLE "payment"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"captured_paise" integer DEFAULT 0 NOT NULL,
	"refunded_paise" integer DEFAULT 0 NOT NULL,
	"reserved_paise" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"provider_charge_id" text,
	"provider_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "payments_provider_key_unique" UNIQUE("provider_key"),
	CONSTRAINT "payments_status_ck" CHECK ("payment"."payments"."status" in ('pending', 'captured', 'declined', 'unknown')),
	CONSTRAINT "payments_amounts_ck" CHECK ("payment"."payments"."captured_paise" >= 0 and "payment"."payments"."refunded_paise" >= 0 and "payment"."payments"."reserved_paise" >= 0
    and "payment"."payments"."captured_paise" <= "payment"."payments"."amount_paise" and "payment"."payments"."refunded_paise" + "payment"."payments"."reserved_paise" <= "payment"."payments"."captured_paise")
);
--> statement-breakpoint
CREATE TABLE "identity"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "restaurant"."restaurants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"restaurant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_ck" CHECK ("identity"."users"."role" in ('Customer', 'RestaurantOwner', 'Admin'))
);
--> statement-breakpoint
ALTER TABLE "restaurant"."menu_items" ADD CONSTRAINT "menu_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordering"."order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "ordering"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_customer_ix" ON "ordering"."orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_restaurant_ix" ON "ordering"."orders" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_ix" ON "identity"."refresh_tokens" USING btree ("family_id");