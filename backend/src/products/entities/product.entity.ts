import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Variation } from './variation.entity';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @OneToMany(() => Variation, (variation) => variation.product)
  variations: Variation[];
}
