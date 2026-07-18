import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { App } from '../app';

@Component({
  selector: 'app-wallet-panel',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './wallet-panel.html',
  styleUrl: './wallet-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WalletPanelComponent {
  app = inject(App);
}
