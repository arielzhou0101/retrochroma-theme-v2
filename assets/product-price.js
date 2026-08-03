import { ThemeEvents, VariantUpdateEvent } from '@theme/events';

/**
 * A custom element that displays a product price.
 * This component listens for variant update events and updates the price display accordingly.
 * It handles price updates from two different sources:
 * 1. Variant picker (in quick add modal or product page)
 * 2. Swatches variant picker (in product cards)
 */
class ProductPrice extends HTMLElement {
  connectedCallback() {
    this.resizeObserver = new ResizeObserver(this.updateSaleLabelLayout);
    this.resizeObserver.observe(this);
    const productCard = this.closest('product-card');
    if (productCard) this.resizeObserver.observe(productCard);
    requestAnimationFrame(this.updateSaleLabelLayout);

    const closestSection = this.closest('.shopify-section, dialog');
    if (!closestSection) return;
    closestSection.addEventListener(ThemeEvents.variantUpdate, this.updatePrice);
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();

    const closestSection = this.closest('.shopify-section, dialog');
    if (!closestSection) return;
    closestSection.removeEventListener(ThemeEvents.variantUpdate, this.updatePrice);
  }

  /**
   * Updates the price.
   * @param {VariantUpdateEvent} event - The variant update event.
   */
  updatePrice = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.target instanceof HTMLElement && event.target.dataset.productId !== this.dataset.productId) {
      return;
    }

    const newPrice = event.detail.data.html.querySelector('product-price [ref="priceContainer"]');
    const currentPrice = this.querySelector('[ref="priceContainer"]');

    if (!newPrice || !currentPrice) return;

    if (currentPrice.innerHTML !== newPrice.innerHTML) {
      currentPrice.replaceWith(newPrice);
      requestAnimationFrame(this.updateSaleLabelLayout);
    }
  };

  /**
   * Keeps the price itself in its original position. The promotion name is
   * hidden when needed; if even the compact discount cannot fit to its right,
   * only that compact discount moves below the price row.
   */
  updateSaleLabelLayout = () => {
    const priceContainer = this.querySelector("[ref='priceContainer'].price-container--card");
    const saleLabel = priceContainer?.querySelector('.sale-price-label');
    const productCard = this.closest('product-card');

    if (!priceContainer || !saleLabel || !productCard) return;

    saleLabel.classList.remove('sale-price-label--compact', 'sale-price-label--stacked');

    const cardRect = productCard.getBoundingClientRect();

    if (saleLabel.getBoundingClientRect().right > cardRect.right) {
      saleLabel.classList.add('sale-price-label--compact');

      if (saleLabel.getBoundingClientRect().right > cardRect.right) {
        saleLabel.classList.add('sale-price-label--stacked');
      }
    }
  };
}

if (!customElements.get('product-price')) {
  customElements.define('product-price', ProductPrice);
}
