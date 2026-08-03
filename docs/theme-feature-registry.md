# Retro Chroma theme feature registry

This file records storefront features, their configuration, dependencies, and release status. Update it in the same pull request whenever a feature is added or its operating procedure changes.

For each feature, record:

- Status and release date
- User-facing behavior and scope
- Theme Editor or Shopify Admin configuration
- External dependencies
- Primary implementation files
- Enable, disable, and verification procedure

## Silk pillowcase second-item promotion

- Status: Staging; not released to live
- Feature branch: `feature/pillow-multi-buy-ui`
- Eligibility: Only the PDP with handle `leopard-print-22-momme-silk-front-pillowcase`.
- Storefront location: The eligible PDP, below the tax note. No collection or recommendations component displays this promotion.
- Badge: `SPECIAL OFFER`, with the theme's inline discount-tag icon
- PDP copy: `Get 15% off your second silk pillowcase automatically.`

### Configuration

Theme Editor path:

1. Open the target theme in **Online Store > Themes > Customize**.
2. Open **Theme settings > Promotions**.
3. Toggle **Show silk pillowcase promotion messaging**.
4. Save the theme.

The setting ID is `settings.pillow_multi_buy_promo_enabled`. Its default is `false`, so a newly installed or newly released copy of the feature stays hidden until explicitly enabled.

This switch controls storefront messaging only. The real promotion must be configured and activated separately in **Shopify Admin > Discounts**. Enabling this switch does not create or validate a discount, and disabling the automatic discount does not hide the storefront messaging.

### Implementation

- `config/settings_schema.json`: Global Theme Editor switch
- `snippets/pillow-multi-buy-promo.liquid`: Shared eligibility, switch, badge, and copy output
- `blocks/price.liquid`: PDP placement and styling

### Verification

- Switch off: No Pillow promotion messaging appears anywhere.
- Switch on, eligible PDP: Badge and the single PDP sentence appear below the tax note.
- Switch on, non-eligible PDP: No promotion messaging appears.
- Collection and recommendations components: No promotion messaging appears.
- Confirm the Shopify automatic discount independently with an eligible two-item cart before live release.

## Accordion and FAQ schema repair

- Status: Released to live on 2026-08-03
- Pull request: `#1 Fix accordion FAQ schema presets`
- Switch: None
- Purpose:
  - Correct the Accordion preset setting from `open_by_default` to `open_by_default_desktop`
  - Allow the Accordion block in the generic Section schema so FAQ presets pass Shopify validation
- Storefront impact: No content is added automatically. The change only repairs schema validation and Theme Editor block availability.
- Primary files:
  - `blocks/accordion.liquid`
  - `sections/section.liquid`
