import { ChangeDetectionStrategy, Component, signal, computed, OnInit, inject, effect } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { Router, ActivatedRoute } from '@angular/router';
import { AirportSelectComponent } from './airport-select';

export interface User {
  id: string;
  email: string;
  name: string;
  wallet_balance: number;
  created_at: string;
}

export interface WalletDeposit {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  amount: number;
  currency: string;
  receipt_number: string;
  receipt_img: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  reviewed_at?: string;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface DuffelOwner {
  name: string;
  logo_symbol_url?: string;
}

export interface DuffelAirport {
  iata_code: string;
  name?: string;
}

export interface DuffelSegment {
  departing_at: string;
  arriving_at: string;
  operating_carrier?: { name: string };
  marketing_carrier?: { name: string };
}

export interface DuffelSlice {
  duration?: string;
  origin: DuffelAirport;
  destination: DuffelAirport;
  segments?: DuffelSegment[];
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  owner: DuffelOwner;
  slices: DuffelSlice[];
  requires_instant_payment: boolean;
  hold_supported: boolean;
}

export interface DuffelPassenger {
  id: string;
  title: string;
  gender: string;
  given_name: string;
  family_name: string;
  born_on?: string;
  email?: string;
  phone_number?: string;
}

export interface DuffelOrder {
  id: string;
  booking_reference: string;
  total_amount: string;
  total_currency: string;
  payment_status: string;
  payment_required_by: string | null;
  passengers: DuffelPassenger[];
  route: string;
  owner_name: string;
  status: 'awaiting_payment' | 'confirmed' | 'cancelled';
  created_at: string;
  tickets?: { passenger_name: string; ticket_number: string }[];
  // Extra fields for Wallet & Hold features
  user_id?: string;
  receipt_number?: string;
  receipt_img?: string;
  admin_review_status?: 'pending_receipt' | 'pending_approval' | 'approved' | 'rejected';
  is_hold_booking?: boolean;
  owner_logo?: string;
  slices?: DuffelSlice[];
  documents?: { unique_identifier: string }[];
  base_amount?: string | number;
  tax_amount?: string | number;
  markup_percentage_at_booking?: number;
  office_markup_amount?: number;
  office_total_amount?: number;
  conditions?: {
    refund_before_departure?: { allowed: boolean } | null;
    change_before_departure?: { allowed: boolean } | null;
  } | null;
}

export interface DuffelSearchResults {
  offer_request_id: string;
  passengers: { id: string; type: string }[];
  offers: DuffelOffer[];
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule, AirportSelectComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private fb = inject(FormBuilder);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  // Sorting state and computed property for sorted flights
  sortBy = signal<'price' | 'duration' | 'departure'>('price');
  sortedOffers = computed(() => {
    const results = this.searchResults();
    if (!results || !results.offers) return [];

    const offersCopy = [...results.offers];
    const sortVal = this.sortBy();

    if (sortVal === 'price') {
      return offersCopy.sort((a, b) => Number(a.total_amount) - Number(b.total_amount));
    } else if (sortVal === 'duration') {
      return offersCopy.sort((a, b) => {
        const durationA = a.slices?.[0]?.duration || 'PT0H0M';
        const durationB = b.slices?.[0]?.duration || 'PT0H0M';
        return durationA.localeCompare(durationB);
      });
    } else if (sortVal === 'departure') {
      return offersCopy.sort((a, b) => {
        const depA = a.slices?.[0]?.segments?.[0]?.departing_at || '';
        const depB = b.slices?.[0]?.segments?.[0]?.departing_at || '';
        return depA.localeCompare(depB);
      });
    }
    return offersCopy;
  });

  constructor() {
    effect(() => {
      const view = this.userView();
      if (view !== 'search-results' && typeof window !== 'undefined' && this.router.url.startsWith('/search-results')) {
        this.router.navigate(['/']);
      }
    });
  }

  // Navigation tabs: 'agency' | 'admin'
  activeTab = signal<'agency' | 'admin'>('agency');
  userView = signal<'home' | 'search-results' | 'bookings' | 'wallet' | 'notifications' | 'profile' | 'login' | 'register' | 'order-details' | 'settings'>('home');

  // Selected order details states
  selectedOrderDetails = signal<DuffelOrder | null>(null);
  orderDetailsLoading = signal<boolean>(false);
  orderDetailsError = signal<string | null>(null);
  pdfDownloading = signal<boolean>(false);

  // Settings states
  officeMarkupPercentage = signal<number>(10);
  settingsLoading = signal<boolean>(false);
  settingsSaving = signal<boolean>(false);
  settingsError = signal<string | null>(null);

  // Active User session
  currentUser = signal<User | null>(null);
  notificationsList = signal<Notification[]>([]);
  userDepositsList = signal<WalletDeposit[]>([]);

  // Admin and other states
  allDepositsList = signal<WalletDeposit[]>([]);
  adminOrdersList = signal<DuffelOrder[]>([]);
  adminDepositsLoading = signal<boolean>(false);
  adminDepositsError = signal<string | null>(null);

  // Forms
  searchForm!: FormGroup;
  passengerForm!: FormGroup;
  loginForm!: FormGroup;
  registerForm!: FormGroup;
  depositForm!: FormGroup;
  holdReceiptForm!: FormGroup;

  // Selected order for receipt upload
  receiptSelectedOrder = signal<DuffelOrder | null>(null);
  showReceiptModal = signal<boolean>(false);

  // Flight search states
  searchLoading = signal<boolean>(false);
  searchError = signal<string | null>(null);
  searchResults = signal<DuffelSearchResults | null>(null);

  // Booking states (Hold)
  selectedOffer = signal<DuffelOffer | null>(null);
  showBookingModal = signal<boolean>(false);
  bookingLoading = signal<boolean>(false);
  bookingError = signal<string | null>(null);
  bookingSuccess = signal<DuffelOrder | null>(null);

  // Admin states
  ordersList = signal<DuffelOrder[]>([]);
  ordersLoading = signal<boolean>(false);
  ordersError = signal<string | null>(null);

  // Admin Pay details
  adminConfirmOffer = signal<DuffelOrder | null>(null);
  showAdminConfirmModal = signal<boolean>(false);
  adminPayLoading = signal<boolean>(false);
  adminPayError = signal<string | null>(null);
  adminPaySuccess = signal<DuffelOrder | null>(null);

  // Toast / Status banner states
  toastMessage = signal<string | null>(null);
  toastType = signal<'success' | 'error' | 'info'>('info');

  ngOnInit() {
    this.initForms();
    this.tryAutoLogin();

    // Listen to query parameters to drive search results
    this.route.queryParams.subscribe(params => {
      const url = this.router.url;
      if (url.startsWith('/search-results')) {
        this.userView.set('search-results');
        if (params['origin'] && params['destination'] && params['departureDate']) {
          this.searchForm.patchValue({
            origin: params['origin'],
            destination: params['destination'],
            departureDate: params['departureDate'],
            cabinClass: params['cabinClass'] || 'economy',
            passengerCount: Number(params['passengerCount']) || 1
          });
          this.executeSearchFromParams(params);
        }
      } else {
        const currentView = this.userView();
        if ((currentView === 'search-results' || currentView === 'home') && (url === '/' || url === '' || url.startsWith('/?'))) {
          this.userView.set('home');
        }
      }
    });
  }

  private initForms() {
    // Search Flights Form
    this.searchForm = this.fb.group({
      origin: ['CAI', [Validators.required, Validators.pattern(/^[A-Za-z]{3}$/)]],
      destination: ['JED', [Validators.required, Validators.pattern(/^[A-Za-z]{3}$/)]],
      departureDate: ['2026-08-15', [Validators.required]],
      cabinClass: ['economy', [Validators.required]],
      passengerCount: [1, [Validators.required, Validators.min(1), Validators.max(9)]]
    });

    // Passenger Details Form (for Bookings)
    this.passengerForm = this.fb.group({
      title: ['mr', [Validators.required]],
      gender: ['m', [Validators.required]],
      givenName: ['', [Validators.required, Validators.minLength(2)]],
      familyName: ['', [Validators.required, Validators.minLength(2)]],
      bornOn: ['1990-01-01', [Validators.required]],
      email: ['', [Validators.required, Validators.email]],
      phoneNumber: ['+966500000000', [Validators.required, Validators.pattern(/^\+?[1-9]\d{1,14}$/)]]
    });

    // Auth Forms
    this.loginForm = this.fb.group({
      email: ['ahmed.devfree@gmail.com', [Validators.required, Validators.email]],
      password: ['123', [Validators.required, Validators.minLength(3)]]
    });

    this.registerForm = this.fb.group({
      name: ['', [Validators.required, Validators.minLength(2)]],
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(3)]]
    });

    // Wallet Deposit Form
    this.depositForm = this.fb.group({
      amount: [250, [Validators.required, Validators.min(10)]],
      receiptNumber: ['', [Validators.required, Validators.minLength(5)]]
    });

    // Hold Receipt Form
    this.holdReceiptForm = this.fb.group({
      receiptNumber: ['', [Validators.required, Validators.minLength(5)]]
    });
  }

  // Get HTTP headers with active user context
  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    const user = this.currentUser();
    if (user) {
      headers['X-User-Id'] = user.id;
    }
    return headers;
  }

  // Attempt automatic login for demo / trial purposes
  async tryAutoLogin() {
    if (typeof window === 'undefined') return;
    
    const cached = localStorage.getItem('برق_user');
    if (cached) {
      try {
        const user = JSON.parse(cached) as User;
        this.currentUser.set(user);
        this.fetchUserData();
        return;
      } catch {
        localStorage.removeItem('برق_user');
      }
    }

    // Default auto-login to ahmed.devfree@gmail.com for premium, instant-ready feel
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ahmed.devfree@gmail.com', password: '123' })
      });
      const data = await response.json() as { user: User };
      if (response.ok && data.user) {
        this.currentUser.set(data.user);
        localStorage.setItem('برق_user', JSON.stringify(data.user));
        this.fetchUserData();
      }
    } catch (err) {
      console.error('Auto login failed:', err);
    }
  }

  // Fetch all data for the active user session
  async fetchUserData() {
    if (typeof window === 'undefined' || !this.currentUser()) return;
    this.fetchUserProfile();
    this.fetchOrders();
    this.fetchNotifications();
    this.fetchUserDeposits();
    this.fetchAdminMarkup();
  }

  // Get active user profile to refresh balance
  async fetchUserProfile() {
    try {
      const response = await fetch('/api/user/profile', {
        headers: this.getHeaders()
      });
      if (response.ok) {
        const user = await response.json() as User;
        this.currentUser.set(user);
        if (typeof window !== 'undefined') {
          localStorage.setItem('برق_user', JSON.stringify(user));
        }
      }
    } catch (e) {
      console.error('Failed to fetch user profile:', e);
    }
  }

  // Get notifications
  async fetchNotifications() {
    try {
      const response = await fetch('/api/user/notifications', {
        headers: this.getHeaders()
      });
      if (response.ok) {
        const data = await response.json() as Notification[];
        this.notificationsList.set(data);
      }
    } catch (e) {
      console.error('Failed to fetch notifications:', e);
    }
  }

  // Mark notification as read
  async markNotificationRead(id: string) {
    try {
      const response = await fetch(`/api/user/notifications/${id}/read`, {
        method: 'POST',
        headers: this.getHeaders()
      });
      if (response.ok) {
        this.fetchNotifications();
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Fetch current user deposits
  async fetchUserDeposits() {
    try {
      // In our mock backend, deposits has all records, we can get all of them and filter or we fetch admin deposits
      const response = await fetch('/api/admin/deposits', {
        headers: this.getHeaders()
      });
      if (response.ok) {
        const data = await response.json() as WalletDeposit[];
        const filtered = data.filter(d => d.user_id === this.currentUser()?.id);
        this.userDepositsList.set(filtered);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Auth: Login
  async login() {
    if (this.loginForm.invalid) {
      this.showToast('يرجى إدخال البريد الإلكتروني وكلمة المرور بشكل صحيح.', 'error');
      return;
    }

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.loginForm.value)
      });
      const data = await response.json() as { success?: boolean; user?: User; error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'فشل تسجيل الدخول.');
      }

      if (data.user) {
        this.currentUser.set(data.user);
        localStorage.setItem('برق_user', JSON.stringify(data.user));
        this.showToast(`أهلاً بك مجدداً، ${data.user.name}!`, 'success');
        this.fetchUserData();
        this.userView.set('home');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'فشل تسجيل الدخول.';
      this.showToast(msg, 'error');
    }
  }

  // Auth: Register
  async register() {
    if (this.registerForm.invalid) {
      this.showToast('يرجى ملء جميع الحقول بشكل صحيح.', 'error');
      return;
    }

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.registerForm.value)
      });
      const data = await response.json() as { success?: boolean; user?: User; error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'فشل تسجيل الحساب.');
      }

      if (data.user) {
        this.currentUser.set(data.user);
        localStorage.setItem('برق_user', JSON.stringify(data.user));
        this.showToast(`تم إنشاء حسابك بنجاح! مرحباً بك، ${data.user.name}!`, 'success');
        this.fetchUserData();
        this.userView.set('home');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'فشل تسجيل الحساب.';
      this.showToast(msg, 'error');
    }
  }

  // Auth: Logout
  logout() {
    this.currentUser.set(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('برق_user');
    }
    this.showToast('تم تسجيل الخروج بنجاح.', 'info');
    this.userView.set('login');
  }

  // Submit wallet deposit request
  async submitWalletDeposit() {
    if (this.depositForm.invalid) {
      this.showToast('يرجى ملء المبلغ ورقم التحويل البنكي.', 'error');
      return;
    }

    try {
      const { amount, receiptNumber } = this.depositForm.value as { amount: number; receiptNumber: string };
      const response = await fetch('/api/wallet/deposit', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ amount, receipt_number: receiptNumber })
      });

      const data = await response.json() as { success?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'فشل إرسال طلب الإيداع.');
      }

      this.showToast('تم إرسال إيصال الإيداع للإدارة بنجاح! سيتم إضافة الرصيد فور المراجعة.', 'success');
      this.depositForm.reset({ amount: 250, receiptNumber: '' });
      this.fetchUserData();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'فشل عملية الإيداع.';
      this.showToast(msg, 'error');
    }
  }

  // Submit hold booking payment receipt
  async submitHoldBookingReceipt() {
    const order = this.receiptSelectedOrder();
    if (!order) return;

    if (this.holdReceiptForm.invalid) {
      this.showToast('الرجاء كتابة رقم إيصال التحويل بشكل صحيح.', 'error');
      return;
    }

    try {
      const { receiptNumber } = this.holdReceiptForm.value as { receiptNumber: string };
      const response = await fetch(`/api/orders/${order.id}/receipt`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ receipt_number: receiptNumber })
      });

      const data = await response.json() as { success?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'فشل رفع الإيصال.');
      }

      this.showToast('تم إرسال إيصال سداد الحجز للإدارة بنجاح! سيتم إصدار تذكرتك فور التحقق.', 'success');
      this.showReceiptModal.set(false);
      this.receiptSelectedOrder.set(null);
      this.holdReceiptForm.reset();
      this.fetchUserData();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'فشل إرسال الإيصال.';
      this.showToast(msg, 'error');
    }
  }

  // Open Receipt Modal
  openReceiptModal(order: DuffelOrder) {
    this.receiptSelectedOrder.set(order);
    this.holdReceiptForm.reset();
    this.showReceiptModal.set(true);
  }

  // Admin APIs
  async fetchAdminDeposits() {
    this.adminDepositsLoading.set(true);
    this.adminDepositsError.set(null);
    try {
      const response = await fetch('/api/admin/deposits', {
        headers: this.getHeaders()
      });
      if (response.ok) {
        const data = await response.json() as WalletDeposit[];
        this.allDepositsList.set(data);
      } else {
        throw new Error('فشل جلب الإيداعات.');
      }
    } catch (e: unknown) {
      this.adminDepositsError.set(e instanceof Error ? e.message : 'خطأ');
    } finally {
      this.adminDepositsLoading.set(false);
    }
  }

adminOrdersLoading = signal<boolean>(false);
adminOrdersError = signal<string | null>(null);

async fetchAdminOrders() {
  this.adminOrdersLoading.set(true);
  this.adminOrdersError.set(null);
  try {
    const response = await fetch('/api/admin/orders', {
      headers: this.getHeaders(),
      cache: 'no-store'   // ⬅️ يمنع الـ 304 ويجبر السيرفر يرجّع بيانات جديدة كل مرة
    });
    if (!response.ok) throw new Error('فشل جلب طلبات النظام.');
    const data = await response.json() as DuffelOrder[];
    this.adminOrdersList.set(data);
  } catch (e: unknown) {
    this.adminOrdersError.set(e instanceof Error ? e.message : 'خطأ');
  } finally {
    this.adminOrdersLoading.set(false);
  }
}

  async approveDeposit(id: string) {
    try {
      this.showToast('جاري الموافقة على الإيداع وشحن محفظة العميل...', 'info');
      const response = await fetch(`/api/admin/deposits/${id}/approve`, {
        method: 'POST',
        headers: this.getHeaders()
      });
      if (response.ok) {
        this.showToast('تم شحن محفظة العميل بنجاح والموافقة على التحويل!', 'success');
        this.fetchAdminDeposits();
        this.fetchUserProfile(); // In case the logged-in user is the one who deposited
      } else {
        throw new Error();
      }
    } catch {
      this.showToast('فشل قبول طلب الإيداع.', 'error');
    }
  }

  async rejectDeposit(id: string) {
    try {
      this.showToast('جاري رفض عملية الإيداع...', 'info');
      const response = await fetch(`/api/admin/deposits/${id}/reject`, {
        method: 'POST',
        headers: this.getHeaders()
      });
      if (response.ok) {
        this.showToast('تم رفض التحويل وإعلام العميل بالإشعار.', 'info');
        this.fetchAdminDeposits();
      } else {
        throw new Error();
      }
    } catch {
      this.showToast('فشل رفض طلب الإيداع.', 'error');
    }
  }

  async confirmAdminOrder(id: string) {
    try {
      this.showToast('جاري التحقق من الإيصال وتأكيد الحجز في نظام دافيل...', 'info');
      const response = await fetch(`/api/admin/orders/${id}/confirm`, {
        method: 'POST',
        headers: this.getHeaders()
      });
      const data = await response.json() as { success?: boolean; error?: string };
      if (response.ok) {
        this.showToast('تم إصدار التذاكر وتأكيد الحجز بنجاح على نظام دافيل!', 'success');
        this.fetchAdminOrders();
      } else {
        throw new Error(data.error || 'فشلت المزامنة والتأكيد.');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'فشل تأكيد حجز دافيل.';
      this.showToast(msg, 'error');
    }
  }

  // Toast Helper
  showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    this.toastMessage.set(message);
    this.toastType.set(type);
    setTimeout(() => {
      // Clear after 6 seconds
      if (this.toastMessage() === message) {
        this.toastMessage.set(null);
      }
    }, 6000);
  }

  // Switch tabs
  switchTab(tab: 'agency' | 'admin') {
    this.activeTab.set(tab);
    if (tab === 'admin') {
      this.fetchAdminOrders();
      this.fetchAdminDeposits();
      this.fetchAdminMarkup();
    } else {
      this.fetchUserData();
    }
  }

  // 1. Search Flights (Navigates to results page)
  async searchFlights() {
    if (this.searchForm.invalid) {
      this.showToast('الرجاء التأكد من صحة جميع حقول البحث.', 'error');
      return;
    }

    const formValues = this.searchForm.value;
    this.router.navigate(['/search-results'], {
      queryParams: {
        origin: formValues.origin,
        destination: formValues.destination,
        departureDate: formValues.departureDate,
        cabinClass: formValues.cabinClass,
        passengerCount: formValues.passengerCount
      }
    });
  }

  // 1b. Execute search from route query parameters
  async executeSearchFromParams(params: Record<string, string | undefined>) {
    const origin = params['origin'] as string;
    const destination = params['destination'] as string;
    const departureDate = params['departureDate'] as string;
    const cabinClass = params['cabinClass'] as string || 'economy';
    const passengerCount = Number(params['passengerCount']) || 1;

    this.searchLoading.set(true);
    this.searchError.set(null);
    this.searchResults.set(null);

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          origin: origin.toUpperCase(),
          destination: destination.toUpperCase(),
          departure_date: departureDate,
          cabin_class: cabinClass,
          passengers: Array(passengerCount).fill({ type: 'adult' })
        })
      });

      const data = await response.json() as { error?: string; offers?: DuffelOffer[]; passengers?: { id: string; type: string }[]; offer_request_id?: string };

      if (!response.ok) {
        throw new Error(data.error || 'فشل البحث عن رحلات الطيران.');
      }

      this.searchResults.set({
        offer_request_id: data.offer_request_id || '',
        passengers: data.passengers || [],
        offers: data.offers || []
      });

      if (!data.offers || data.offers.length === 0) {
        this.showToast('لم يتم العثور على رحلات في هذا التاريخ المختار.', 'info');
      } else {
        this.showToast('تم العثور على عروض رحلات مباشرة وموثوقة من دافيل!', 'success');
      }
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'حدث خطأ غير متوقع أثناء البحث.';
      this.searchError.set(message);
      this.showToast(message, 'error');
    } finally {
      this.searchLoading.set(false);
    }
  }

  // 2. Open Booking Modal
  openBookingModal(offer: DuffelOffer) {
    if (!this.currentUser()) {
      this.showToast('الرجاء تسجيل الدخول أولاً لتتمكن من حجز هذه الرحلة.', 'info');
      this.userView.set('login');
      return;
    }

    this.selectedOffer.set(offer);
    this.passengerForm.patchValue({
      title: 'mr',
      gender: 'm',
      givenName: '',
      familyName: '',
      bornOn: '1990-01-01',
      email: this.currentUser()?.email || '',
      phoneNumber: '+966500000000'
    });
    this.bookingError.set(null);
    this.bookingSuccess.set(null);
    this.showBookingModal.set(true);
  }

  // Close Booking Modal
  closeBookingModal() {
    this.showBookingModal.set(false);
    this.selectedOffer.set(null);
  }

  // 3. Confirm Hold Booking (POST /api/orders/hold)
  async confirmHoldBooking() {
    if (this.passengerForm.invalid) {
      this.showToast('الرجاء تعبئة بيانات الراكب بشكل صحيح.', 'error');
      return;
    }

    const offer = this.selectedOffer();
    if (!offer) return;

    this.bookingLoading.set(true);
    this.bookingError.set(null);

    try {
      const formVal = this.passengerForm.value as { title: string; gender: string; givenName: string; familyName: string; bornOn: string; email: string; phoneNumber: string };
      const passengerId = this.searchResults()?.passengers?.[0]?.id || 'pas_temp_01';

      // Route summary
      const slice = offer.slices?.[0];
      const route = slice 
        ? `${slice.origin?.iata_code || this.searchForm.get('origin')?.value} ➔ ${slice.destination?.iata_code || this.searchForm.get('destination')?.value}`
        : `${this.searchForm.get('origin')?.value} ➔ ${this.searchForm.get('destination')?.value}`;

      const payload = {
        offer_id: offer.id,
        passengers: [
          {
            id: passengerId,
            title: formVal.title,
            gender: formVal.gender,
            given_name: formVal.givenName,
            family_name: formVal.familyName,
            born_on: formVal.bornOn,
            email: formVal.email,
            phone_number: formVal.phoneNumber
          }
        ],
        route_summary: route,
        owner_name: offer.owner?.name || 'طيران شريك'
      };

      const response = await fetch('/api/orders/hold', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload)
      });

      const data = await response.json() as DuffelOrder & { error?: string };

      if (!response.ok) {
        throw new Error(data.error || 'فشل إتمام الحجز المؤقت في دافيل.');
      }

      this.bookingSuccess.set(data);
      this.showToast('تم الحجز المؤقت بنجاح! يرجى رفع إيصال السداد في ملفك الشخصي قبل انتهاء المهلة.', 'success');
      
      // Update local orders
      this.fetchUserData();
      setTimeout(() => {
        this.closeBookingModal();
        this.userView.set('bookings');
      }, 3000);
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'حدث خطأ أثناء إجراء الحجز المؤقت.';
      this.bookingError.set(message);
      this.showToast(message, 'error');
    } finally {
      this.bookingLoading.set(false);
    }
  }

  // 3b. Confirm Instant Booking (POST /api/orders/instant)
  async confirmInstantBooking() {
    if (this.passengerForm.invalid) {
      this.showToast('الرجاء تعبئة بيانات الراكب بشكل صحيح.', 'error');
      return;
    }

    const offer = this.selectedOffer();
    if (!offer) return;

    // Check user balance locally before starting loading to give instant warning
    const balance = this.currentUser()?.wallet_balance || 0;
    const price = Number(offer.total_amount);
    if (balance < price) {
      this.showToast(`رصيد المحفظة غير كافٍ لإجراء الحجز المباشر ($${balance.toFixed(2)} USD). يرجى شحن محفظتك أولاً بقيمة $${price.toFixed(2)} USD.`, 'error');
      return;
    }

    this.bookingLoading.set(true);
    this.bookingError.set(null);

    try {
      const formVal = this.passengerForm.value as { title: string; gender: string; givenName: string; familyName: string; bornOn: string; email: string; phoneNumber: string };
      const passengerId = this.searchResults()?.passengers?.[0]?.id || 'pas_temp_01';

      // Route summary
      const slice = offer.slices?.[0];
      const route = slice 
        ? `${slice.origin?.iata_code || this.searchForm.get('origin')?.value} ➔ ${slice.destination?.iata_code || this.searchForm.get('destination')?.value}`
        : `${this.searchForm.get('origin')?.value} ➔ ${this.searchForm.get('destination')?.value}`;

      const payload = {
        offer_id: offer.id,
        passengers: [
          {
            id: passengerId,
            title: formVal.title,
            gender: formVal.gender,
            given_name: formVal.givenName,
            family_name: formVal.familyName,
            born_on: formVal.bornOn,
            email: formVal.email,
            phone_number: formVal.phoneNumber
          }
        ],
        route_summary: route,
        owner_name: offer.owner?.name || 'طيران شريك',
        total_amount: offer.total_amount,
        total_currency: offer.total_currency
      };

      const response = await fetch('/api/orders/instant', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload)
      });

      const data = await response.json() as DuffelOrder & { error?: string };

      if (!response.ok) {
        throw new Error(data.error || 'فشل إتمام الحجز الفوري وإصدار التذاكر في دافيل.');
      }

      this.bookingSuccess.set(data);
      this.showToast('تم الحجز والدفع المباشر من محفظتك الإلكترونية بنجاح وإصدار التذاكر الفورية!', 'success');
      
      // Update user details
      this.fetchUserData();
      setTimeout(() => {
        this.closeBookingModal();
        this.userView.set('bookings');
      }, 3000);
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'حدث خطأ غير متوقع أثناء الحجز الفوري.';
      this.bookingError.set(message);
      this.showToast(message, 'error');
    } finally {
      this.bookingLoading.set(false);
    }
  }

  // 4. Fetch local orders (GET /api/orders)
  async fetchOrders() {
    if (typeof window === 'undefined') {
      return;
    }
    this.ordersLoading.set(true);
    this.ordersError.set(null);

    try {
      const response = await fetch('/api/orders', {
        headers: this.getHeaders()
      });
      if (!response.ok) throw new Error('فشل في جلب قائمة الحجوزات الخاصة بك.');
      const data = await response.json() as DuffelOrder[];
      this.ordersList.set(data);
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'فشل جلب الحجوزات.';
      this.ordersError.set(message);
    } finally {
      this.ordersLoading.set(false);
    }
  }

  // 5. Refresh Order price and status (GET /api/orders/:order_id/refresh)
  async refreshOrder(order: DuffelOrder) {
    try {
      this.showToast(`جاري تحديث حالة الحجز لـ ${order.booking_reference}...`, 'info');
      const response = await fetch(`/api/orders/${order.id}/refresh`, {
        headers: this.getHeaders()
      });
      if (!response.ok) throw new Error('فشل تحديث الحجز من خوادم دافيل.');
      
      await this.fetchOrders();
      this.showToast('تم تحديث بيانات وحالة الحجز بنجاح!', 'success');
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'فشل التحديث.';
      this.showToast(message, 'error');
    }
  }

  // 6. Open Admin Confirm Pay Modal (Step 1: Refresh + Show Modal)
  async openAdminPayModal(order: DuffelOrder) {
    this.adminConfirmOffer.set(order);
    this.adminPayError.set(null);
    this.adminPaySuccess.set(null);
    this.showAdminConfirmModal.set(true);

    try {
      // Auto refresh before paying to avoid price drift (Price-drift safety check)
      const response = await fetch(`/api/orders/${order.id}/refresh`, {
        headers: this.getHeaders()
      });
      const updatedData = await response.json() as { total_amount: string; total_currency: string; payment_status: string; payment_required_by: string | null };
      
      if (response.ok) {
        // Update the in-memory representation in our modal
        this.adminConfirmOffer.update(curr => {
          if (curr && curr.id === order.id) {
            return {
              ...curr,
              total_amount: updatedData.total_amount,
              total_currency: updatedData.total_currency,
              payment_status: updatedData.payment_status,
              payment_required_by: updatedData.payment_required_by
            };
          }
          return curr;
        });
      }
    } catch (err) {
      console.error('Pre-pay refresh warning:', err);
    }
  }

  // 7. Confirm & Pay Order (POST /api/orders/:order_id/pay)
  async confirmAndPayOrder() {
    const order = this.adminConfirmOffer();
    if (!order) return;

    this.adminPayLoading.set(true);
    this.adminPayError.set(null);

    try {
      const response = await fetch(`/api/orders/${order.id}/pay`, {
        method: 'POST',
        headers: this.getHeaders()
      });

      const data = await response.json() as { success?: boolean; booking_reference?: string; payment_status?: string; tickets?: { passenger_name: string; ticket_number: string }[]; error?: string; code?: string };

      if (!response.ok) {
        let msg = 'فشل الدفع وتأكيد التذاكر.';
        if (data.code === 'insufficient_balance') {
          msg = '⚠️ رصيد الحساب غير كافٍ لإتمام حجز هذه الرحلة (Duffel Insufficient Balance).';
        } else if (data.code === 'price_changed') {
          msg = '⚠️ تغيرت أسعار هذه الرحلة في دافيل، يرجى تحديث الحجز وإعادة المحاولة.';
        } else if (data.code === 'schedule_changed') {
          msg = '⚠️ تغير جدول الرحلة من قبل شركة الطيران، يرجى مراجعة التغييرات.';
        } else if (data.error) {
          msg = `خطأ: ${data.error}`;
        }
        throw new Error(msg);
      }

      // Prepare updated order object with tickets
      const tickets = data.tickets || [];
      const confirmedOrder = {
        ...order,
        status: 'confirmed' as const,
        payment_status: data.payment_status || 'paid',
        tickets
      };
      this.adminConfirmOffer.set(confirmedOrder);
      this.adminPaySuccess.set(confirmedOrder);

      this.showToast(`تم تأكيد الحجز ${order.booking_reference} وإصدار التذاكر الإلكترونية بنجاح!`, 'success');
      
      // Update local bookings
      this.fetchOrders();
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'فشل في إتمام عملية الدفع وإصدار التذكرة.';
      this.adminPayError.set(message);
      this.showToast(message, 'error');
    } finally {
      this.adminPayLoading.set(false);
    }
  }

  // 8. Cancel Order (POST /api/orders/:order_id/cancel)
  async cancelOrder(order: DuffelOrder) {
    if (!confirm(`هل أنت متأكد من رغبتك في إلغاء الحجز المؤقت ${order.booking_reference}؟`)) {
      return;
    }

    try {
      this.showToast(`جاري إلغاء الحجز ${order.booking_reference}...`, 'info');
      const response = await fetch(`/api/orders/${order.id}/cancel`, {
        method: 'POST',
        headers: this.getHeaders()
      });

      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || 'فشل إلغاء الحجز من دافيل.');

      this.showToast('تم إلغاء الحجز المؤقت وتحرير المقاعد بنجاح بنظام دافيل!', 'success');
      this.fetchUserData();
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'فشل إلغاء الحجز.';
      this.showToast(message, 'error');
    }
  }

  // Utilities for formatting duration
  formatDuration(isoDuration: string | undefined): string {
    if (!isoDuration) return 'مباشر';
    // Format e.g. "PT2H15M" into "2 س و 15 د"
    const hoursMatch = isoDuration.match(/(\d+)H/);
    const minutesMatch = isoDuration.match(/(\d+)M/);
    const h = hoursMatch ? hoursMatch[1] : '';
    const m = minutesMatch ? minutesMatch[1] : '';
    if (h && m) return `${h} س ${m} د`;
    if (h) return `${h} ساعات`;
    if (m) return `${m} دقيقة`;
    return 'مباشر';
  }

  formatTime(isoDateTime: string | undefined): string {
    if (!isoDateTime) return '';
    const date = new Date(isoDateTime);
    return date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  formatDate(isoDateTime: string | undefined): string {
    if (!isoDateTime) return '';
    const date = new Date(isoDateTime);
    return date.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' });
  }

  // Calculates countdown until hold expiry
  getCountdown(expiryStr: string | null): string {
    if (!expiryStr) return 'غير محدد';
    const expiry = new Date(expiryStr).getTime();
    const now = new Date().getTime();
    const diff = expiry - now;
    if (diff <= 0) return 'منتهي الصلاحية ⚠️';

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `متبقي ${hours} س و ${minutes} د`;
  }

  // Fetch and view order details page
  async viewOrderDetails(orderId: string) {
    this.orderDetailsLoading.set(true);
    this.orderDetailsError.set(null);
    this.selectedOrderDetails.set(null);
    this.userView.set('order-details');
    try {
      const response = await fetch(`/api/orders/${orderId}`, {
        headers: this.getHeaders()
      });
      if (!response.ok) {
        throw new Error('فشل جلب تفاصيل الحجز.');
      }
      const data = await response.json();
      this.selectedOrderDetails.set(data);
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'حدث خطأ في جلب تفاصيل الحجز.';
      this.orderDetailsError.set(msg);
    } finally {
      this.orderDetailsLoading.set(false);
    }
  }

  // Download PDF Itinerary / ticket coupon
  downloadItineraryPDF(orderId: string) {
    if (this.pdfDownloading()) return;
    this.pdfDownloading.set(true);
    
    fetch(`/api/orders/${orderId}/itinerary-pdf`, {
      headers: this.getHeaders()
    })
      .then(res => {
        if (!res.ok) throw new Error('فشل تحميل ملف الـ PDF. يرجى المحاولة لاحقاً.');
        return res.blob();
      })
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `itinerary-${orderId}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        this.showToast('تم تحميل وثيقة برنامج الرحلة بنجاح! 📄', 'success');
      })
      .catch(err => {
        console.error('PDF download error:', err);
        this.showToast(err.message || 'حدث خطأ أثناء تحميل الـ PDF.', 'error');
      })
      .finally(() => {
        this.pdfDownloading.set(false);
      });
  }

  // Share booking via WhatsApp with two-step flow (Download + WhatsApp redirect)
  shareViaWhatsApp(order: DuffelOrder) {
    // 1. Trigger local PDF download
    this.downloadItineraryPDF(order.id);

    // 2. Format a professional WhatsApp message in Arabic
    const passengersText = order.passengers?.map(p => `- ${p.title?.toUpperCase()}. ${p.given_name} ${p.family_name}`).join('\n') || '';
    
    let textMessage = `مرحباً بك،\n\nإليك تفاصيل برنامج حجز الطيران الخاص بك:\n`;
    textMessage += `📌 رقم مرجع الحجز (PNR): *${order.booking_reference}*\n`;
    textMessage += `✈️ خط سير الرحلة: *${order.route || 'طيران رسمي'}*\n`;
    textMessage += `🏢 شركة الطيران: *${order.owner_name}*\n`;
    
    if (passengersText) {
      textMessage += `\n👥 أسماء المسافرين:\n${passengersText}\n`;
    }
    
    if (order.status === 'confirmed') {
      textMessage += `\n✅ حالة الحجز: *مؤكد ومُصدر بنجاح*\n`;
      if (order.tickets && order.tickets.length > 0) {
        textMessage += `🎟️ أرقام التذاكر الإلكترونية:\n`;
        order.tickets.forEach(t => {
          textMessage += `- ${t.passenger_name}: ${t.ticket_number}\n`;
        });
      }
    } else {
      textMessage += `\n⏳ حالة الحجز: *حجز مؤقت بانتظار السداد*\n`;
    }

    textMessage += `\n💰 المبلغ الإجمالي: *${order.office_total_amount} ${order.total_currency}*\n`;
    textMessage += `\n📄 لقد قمنا بتحميل وثيقة البرنامج الرسمية (PDF) على جهازك، يرجى إرفاقها وإرسالها مع هذه الرسالة للعميل.`;
    textMessage += `\n\nشكراً لاختيارك *برق B2B*!`;

    const encodedText = encodeURIComponent(textMessage);
    const waUrl = `https://api.whatsapp.com/send?text=${encodedText}`;
    
    // Open in a new tab safely
    if (typeof window !== 'undefined') {
      window.open(waUrl, '_blank');
    }
  }

  // Fetch platform markup settings silently for Admin panel
  async fetchAdminMarkup() {
    this.settingsLoading.set(true);
    this.settingsError.set(null);
    try {
      const response = await fetch('/api/settings/markup', {
        headers: this.getHeaders()
      });
      if (response.ok) {
        const data = await response.json() as { office_markup_percentage: number };
        this.officeMarkupPercentage.set(data.office_markup_percentage);
      } else {
        throw new Error('فشل تحميل إعدادات هامش الربح.');
      }
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'حدث خطأ في النظام.';
      this.settingsError.set(msg);
    } finally {
      this.settingsLoading.set(false);
    }
  }

  // Save office markup settings
  async saveSettings() {
    this.settingsSaving.set(true);
    this.settingsError.set(null);
    try {
      const response = await fetch('/api/settings/markup', {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify({ office_markup_percentage: this.officeMarkupPercentage() })
      });
      const data = await response.json();
      if (response.ok) {
        this.showToast('تم حفظ هامش ربح المكتب بنجاح!', 'success');
      } else {
        throw new Error(data.error || 'فشل حفظ الإعدادات.');
      }
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء حفظ الإعدادات.';
      this.showToast(msg, 'error');
    } finally {
      this.settingsSaving.set(false);
    }
  }
  popularRoutes = [
  { code: 'JED', city: 'جدة',    fromPrice: 90,  image: 'https://picsum.photos/seed/jeddah-route/400/500' },
  { code: 'DXB', city: 'دبي',    fromPrice: 130, image: 'https://picsum.photos/seed/dubai-route/400/500' },
  { code: 'IST', city: 'إسطنبول', fromPrice: 150, image: 'https://picsum.photos/seed/istanbul-route/400/500' },
  { code: 'CAI', city: 'القاهرة', fromPrice: 60,  image: 'https://picsum.photos/seed/cairo-route/400/500' },
];

quickFillRoute(route: { code: string }) {
  this.searchForm.get('destination')?.setValue(route.code);
}
currentYear = new Date().getFullYear();
}
