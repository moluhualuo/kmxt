const MERCHANT_KEY = 'kmxt.selectedMerchant';
const APP_KEY = 'kmxt.selectedApp';

function initialState() {
  return {
    user: null,
    merchants: [],
    applications: [],
    selectedMerchantId: sessionStorage.getItem(MERCHANT_KEY),
    selectedAppId: sessionStorage.getItem(APP_KEY),
    view: 'overview',
    licensePage: 1,
    licenseLimit: 20,
    licenseStatus: '',
    licenseSearch: '',
    selectedLicenseIds: [],
    logMode: 'audit',
    logPage: 1,
    products: [],
    orders: [],
    orderPage: 1,
    orderStatus: '',
    orderNo: '',
    orderFrom: '',
    orderTo: '',
    sidebarOpen: false,
    auditAction: '',
    verificationEvent: '',
    verificationResultCode: '',
    logFrom: '',
    logTo: '',
    busy: false,
  };
}

class Store {
  constructor() {
    this.value = initialState();
  }

  patch(values) {
    Object.assign(this.value, values);
    if (Object.hasOwn(values, 'selectedMerchantId')) {
      values.selectedMerchantId
        ? sessionStorage.setItem(MERCHANT_KEY, values.selectedMerchantId)
        : sessionStorage.removeItem(MERCHANT_KEY);
    }
    if (Object.hasOwn(values, 'selectedAppId')) {
      values.selectedAppId
        ? sessionStorage.setItem(APP_KEY, values.selectedAppId)
        : sessionStorage.removeItem(APP_KEY);
    }
  }

  reset() {
    sessionStorage.removeItem(MERCHANT_KEY);
    sessionStorage.removeItem(APP_KEY);
    this.value = initialState();
  }

  get merchant() {
    return this.value.merchants.find((item) => item.id === this.value.selectedMerchantId) || null;
  }

  get application() {
    return this.value.applications.find((item) => item.id === this.value.selectedAppId) || null;
  }
}

export const store = new Store();
