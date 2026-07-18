import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AirportSelectComponent } from '../airport-select';
import { App } from '../app';

@Component({
  selector: 'app-search-form',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule, AirportSelectComponent],
  templateUrl: './search-form.html',
  styleUrl: './search-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchFormComponent {
  app = inject(App);
}
