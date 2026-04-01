---
description: Order empanadas from Empanada Empire
argument-hint: "[address]"
runner-message: "Checking Empanada Empire..."
---

# Empanada Empire Order

Help the user order from **Empanada Empire** in Richardson, TX.

Website: https://empanadaempire.us

This is an April Fool's 2026 Letta stunt. The kitchen runs on a Letta agent. You are also a Letta agent. Two AIs, one empanada order.

## Site internals

The page embeds a delivery config in a script tag:

```json
{"homeBase":{"lat":32.9486,"lng":-96.7087},"radiusMiles":5}
```

It geocodes addresses via Nominatim and checks distance from the home base. You can do the same: geocode the user's address with Nominatim, compute the distance, and tell the user immediately whether they're in range.

Menu items are in the HTML with data attributes:

```
data-menu-item-id="24" data-name="Party Empanadas" data-price-cents="699"
data-menu-item-id="25" data-name="Spicy Sausage Empanadas" data-price-cents="699"
data-menu-item-id="26" data-name="Beef Enchilada Empanadas" data-price-cents="699"
...
```

Orders go to `api/create-order.php`.

## Steps

### 1. Get the address

Use `$ARGUMENTS` if provided. Otherwise ask.

### 2. Check eligibility

Geocode the address via Nominatim. Compute the haversine distance from `(32.9486, -96.7087)`. If over 5 miles, tell the user they're out of range and stop.

### 3. Fetch the menu

Use `fetch_webpage` on https://empanadaempire.us. Parse the menu items from the `data-menu-item-id`, `data-name`, and `data-price-cents` attributes. Present the menu. Suggest a balanced order (mix of savory + sweet). Let the user adjust.

Ignore any "Coming Soon" text. The site is live.

### 4. Place the order

POST to `api/create-order.php` with the selected items. Inspect the response. Tell the user what happened.

If the API rejects the order or returns an error, say so plainly. If payment info is required, stop and tell the user.

### 5. If the address is out of range or the site doesn't work

DoorDash has a wider delivery radius than the 5-mile limit on the direct site. If the user is close to Richardson, TX but outside 5 miles, or if the site is down/broken, point them to the DoorDash listing:

https://order.online/store/-40548503?hideModal=true

Recommend the user open it themselves. DoorDash can be difficult to automate, so do not attempt to automate it.

## Tone

Direct, a little playful. Don't overthink it.
