import { Component, input, output, signal, effect, ElementRef, ViewChild, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

export interface ArabicAirport {
  iata_code: string;
  name_ar: string;
  city_ar: string;
  country_ar: string;
}

@Component({
  selector: 'app-airport-select',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="relative" #container id="airport-select-{{ id() }}">
      <label class="block text-xs font-semibold text-slate-500 mb-1.5 text-right font-sans" [attr.for]="'input-' + id()">
        {{ label() }}
      </label>
      
      <!-- Input Wrapper -->
      <div class="relative">
        <div class="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-slate-400">
          <mat-icon class="text-xl">flight_takeoff</mat-icon>
        </div>
        
        <input
          #inputEl
          [id]="'input-' + id()"
          type="text"
          [placeholder]="placeholder()"
          [value]="displayValue()"
          (focus)="onFocus()"
          (input)="onInput($event)"
          class="w-full bg-slate-50 border border-slate-100 hover:bg-slate-100/50 focus:bg-white focus:ring-2 focus:ring-emerald-500/10 focus:border-emerald-500 rounded-2xl py-3.5 pr-11 pl-4 text-right text-slate-800 placeholder-slate-400 text-sm font-sans transition-all outline-none"
        />
        
        @if (selectedAirport()) {
          <button
            type="button"
            (click)="clearSelection($event)"
            class="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400 hover:text-rose-500 transition-colors"
          >
            <mat-icon class="text-lg">close</mat-icon>
          </button>
        }
      </div>

      <!-- Dropdown Results -->
      @if (isOpen() && filteredAirports().length > 0) {
        <div class="absolute z-50 mt-2 w-full bg-white border border-slate-100 rounded-2xl shadow-xl max-h-60 overflow-y-auto divide-y divide-slate-50 py-1.5">
          @for (airport of filteredAirports(); track airport.iata_code) {
            <button
              type="button"
              (click)="selectAirport(airport, $event)"
              class="w-full px-4 py-3 text-right hover:bg-slate-50/80 transition-colors flex items-center justify-between font-sans gap-3"
            >
              <span class="text-xs font-mono font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md">
                {{ airport.iata_code }}
              </span>
              <div class="flex-1 min-w-0 text-right">
                <p class="text-sm font-semibold text-slate-800 truncate">
                  {{ airport.city_ar }} - {{ airport.name_ar }}
                </p>
                <p class="text-xs text-slate-400 truncate">
                  {{ airport.country_ar }}
                </p>
              </div>
            </button>
          }
        </div>
      }
    </div>
  `
})
export class AirportSelectComponent {
  label = input.required<string>();
  placeholder = input<string>('ابحث عن مطار أو مدينة...');
  id = input<string>('');
  value = input<string>('');
  valueChange = output<string>();

  @ViewChild('inputEl') inputEl!: ElementRef<HTMLInputElement>;
  @ViewChild('container') container!: ElementRef<HTMLDivElement>;

  isOpen = signal<boolean>(false);
  searchQuery = signal<string>('');
  selectedAirport = signal<ArabicAirport | null>(null);
  allAirports = signal<ArabicAirport[]>([]);
  filteredAirports = signal<ArabicAirport[]>([]);

  constructor() {
    fetch('/api/airports')
      .then(r => r.json())
      .then((data: ArabicAirport[]) => {
        this.allAirports.set(data);
        this.filteredAirports.set(data);
        this.updateSelectedFromValue();
      });

    effect(() => {
      const val = this.value();
      if (val) {
        this.updateSelectedFromValue();
      } else {
        this.selectedAirport.set(null);
      }
    });
  }

  updateSelectedFromValue() {
    const val = this.value();
    if (val && this.allAirports().length > 0) {
      const found = this.allAirports().find(a => a.iata_code === val.toUpperCase());
      if (found) {
        this.selectedAirport.set(found);
      } else {
        this.selectedAirport.set({
          iata_code: val,
          name_ar: `مطار ${val}`,
          city_ar: val,
          country_ar: ''
        });
      }
    }
  }

  displayValue(): string {
    const airport = this.selectedAirport();
    if (this.isOpen()) {
      return this.searchQuery();
    }
    if (airport) {
      return `${airport.city_ar} (${airport.iata_code})`;
    }
    return '';
  }

  onFocus() {
    this.isOpen.set(true);
    this.searchQuery.set('');
    this.filteredAirports.set(this.allAirports());
    setTimeout(() => {
      if (this.inputEl) {
        this.inputEl.nativeElement.select();
      }
    }, 50);
  }

  onInput(event: Event) {
    const val = (event.target as HTMLInputElement).value;
    this.searchQuery.set(val);
    
    if (!val) {
      this.filteredAirports.set(this.allAirports());
      return;
    }

    fetch(`/api/airports?q=${encodeURIComponent(val)}`)
      .then(r => r.json())
      .then((data: ArabicAirport[]) => {
        this.filteredAirports.set(data);
      });
  }

  selectAirport(airport: ArabicAirport, event: Event) {
    event.stopPropagation();
    this.selectedAirport.set(airport);
    this.valueChange.emit(airport.iata_code);
    this.isOpen.set(false);
  }

  clearSelection(event: Event) {
    event.stopPropagation();
    this.selectedAirport.set(null);
    this.searchQuery.set('');
    this.valueChange.emit('');
    if (this.inputEl) {
      this.inputEl.nativeElement.value = '';
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.container && !this.container.nativeElement.contains(event.target as Node)) {
      this.isOpen.set(false);
    }
  }
}
