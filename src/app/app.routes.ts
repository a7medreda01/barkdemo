import {Routes} from '@angular/router';
import {DummyComponent} from './dummy';

export const routes: Routes = [
  { path: '', component: DummyComponent },
  { path: 'search-results', component: DummyComponent },
  { path: '**', redirectTo: '' }
];
