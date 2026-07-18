import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { App } from '../app';

@Component({
  selector: 'app-bookings-list',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './bookings-list.html',
  styleUrl: './bookings-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookingsListComponent {
  app = inject(App);
}
