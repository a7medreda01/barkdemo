import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { App } from '../app';

@Component({
  selector: 'app-booking-modal',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './booking-modal.html',
  styleUrl: './booking-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookingModalComponent {
  app = inject(App);
  
}
