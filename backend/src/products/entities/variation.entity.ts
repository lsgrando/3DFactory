import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Product } from './product.entity';

@Entity('variations')
export class Variation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string; // e.g., "Small", "Large"

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price: number;

  @Column({ type: 'decimal', precision: 10, scale: 3 })
  materialConsumption: number; // Consumption in units/kg

  @ManyToOne(() => Product, (product) => product.variations)
  product: Product;
}
