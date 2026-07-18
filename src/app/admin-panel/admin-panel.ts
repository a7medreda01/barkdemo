import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { App } from '../app';

@Component({
  selector: 'app-admin-panel',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './admin-panel.html',
  styleUrl: './admin-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPanelComponent {
  app = inject(App);
}
